import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Catalogue, EmbedExperiencesResult } from "../src/core/catalogue/ports.ts";
import type { DataProcessing, ProcessingOutcome } from "../src/core/data-processing/ports.ts";
import type { Discovery, RunSummary, Source } from "../src/core/discovery/ports.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import type { CatalogueSettings, DiscoverySettings, ProcessingSettings } from "../src/core/shared/settings.ts";
import { DRAIN_SAFETY_NET_CRON, EMBED_SAFETY_NET_CRON, startJobs } from "../src/scheduler/jobs.ts";
import { FakeJobQueue } from "./helpers/fake-job-queue.ts";

// The job handlers on an in-memory queue, with fakes of Catalogue, Discovery and Data processing. No database.

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

const notUsed = () => Promise.reject(new Error("not used"));

const discoverySettings: DiscoverySettings = {
  defaultFetchIntervalHours: 168,
  defaultMissedRunsBeforeRemoval: 3,
  defaultMaxProcessingAttempts: 3,
  scheduleCron: "*/15 * * * *",
  runTimeoutMinutes: 60,
  fetchRetries: 5,
  fetchRetryBackoffMinutes: 15,
  fetchTimeoutSeconds: 30,
  userAgent: "test",
  horizonMonths: 24,
  credentials: {},
};

function source(id: string): Source {
  return {
    id,
    name: `Source ${id}`,
    kind: "web_page",
    locationId: "location",
    settings: {},
    credentialsSetting: null,
    priority: 0,
    fetchIntervalHours: 168,
    missedRunsBeforeRemoval: 3,
    maxProcessingAttempts: 3,
    active: true,
  };
}

function run(sourceId: string, changes: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: `run-${sourceId}`,
    sourceId,
    sourceName: `Source ${sourceId}`,
    status: "succeeded",
    complete: true,
    listingsFound: 0,
    listingsNewOrChanged: 0,
    listingsUnchanged: 0,
    listingsRemoved: 0,
    error: null,
    ...changes,
  };
}

function outcome(id: string, failed = false): ProcessingOutcome {
  return {
    rawListingId: id,
    listingId: `listing-${id}`,
    sourceName: "Source",
    outcome: failed ? "failed" : "processed",
    experiences: failed ? 0 : 1,
    created: failed ? 0 : 1,
    changed: 0,
    unlinked: 0,
    error: failed ? "The model gave no answer." : null,
  };
}

function fakeDiscovery(overrides: Partial<Discovery>): Discovery {
  return {
    saveSource: notUsed,
    listSources: notUsed,
    findDueSources: notUsed,
    runSource: notUsed,
    runLocation: notUsed,
    getListing: notUsed,
    requeueListings: notUsed,
    claimPendingRawListing: notUsed,
    markRawListingProcessed: notUsed,
    markRawListingFailed: notUsed,
    getListingPriorities: notUsed,
    ...overrides,
  };
}

function fakeDataProcessing(processNext: DataProcessing["processNext"]): DataProcessing {
  return {
    processNext,
    processPending: notUsed,
    reprocess: notUsed,
    saveAttribute: notUsed,
    saveTag: notUsed,
    saveSeason: notUsed,
  };
}

function fakeCatalogue(overrides: Partial<Catalogue>): Catalogue {
  return {
    searchExperiences: notUsed,
    saveLocation: notUsed,
    getLocation: notUsed,
    getExperience: notUsed,
    findExperiencesByListing: notUsed,
    findMatchCandidates: notUsed,
    saveExperience: notUsed,
    removeSourceLink: notUsed,
    getChangesSince: notUsed,
    keepUp: notUsed,
    embedExperiences: notUsed,
    ...overrides,
  };
}

// Hands out the outcomes in order, then null.
function outcomesInOrder(outcomes: ProcessingOutcome[]): { processNext: DataProcessing["processNext"]; calls: () => number } {
  let calls = 0;
  return {
    processNext: () => {
      calls += 1;
      return Promise.resolve(outcomes.shift() ?? null);
    },
    calls: () => calls,
  };
}

async function start(options: {
  catalogue?: Partial<Catalogue>;
  discovery?: Partial<Discovery>;
  processNext?: DataProcessing["processNext"];
  processing?: Partial<ProcessingSettings>;
  catalogueSettings?: Partial<CatalogueSettings>;
}) {
  const queue = new FakeJobQueue();
  const jobs = await startJobs({
    queue,
    catalogue: fakeCatalogue(options.catalogue ?? {}),
    discovery: fakeDiscovery(options.discovery ?? {}),
    dataProcessing: fakeDataProcessing(options.processNext ?? notUsed),
    discoverySettings,
    processingSettings: { workers: 1, horizonMonths: 24, ...options.processing },
    catalogueSettings: {
      searchDefaultRadiusKm: 25,
      searchMaxRadiusKm: 200,
      sessionHorizonMonths: 24,
      upkeepCron: "0 * * * *",
      ...options.catalogueSettings,
    },
    logger: silent,
  });
  return { queue, jobs };
}

describe("startJobs", () => {
  test("registers the jobs, starts the queue and sets their cron schedules", async () => {
    const { queue, jobs } = await start({});
    assert.deepEqual(
      [...queue.handlers.keys()].sort(),
      [
        "catalogue.embed-experiences",
        "catalogue.keep-up",
        "discovery.fetch-source",
        "discovery.find-due-sources",
        "processing.process-pending",
      ],
    );
    assert.equal(queue.started, true);
    assert.deepEqual(queue.schedules.get("discovery.find-due-sources"), {
      name: "discovery.find-due-sources",
      cron: "*/15 * * * *",
      payload: {},
      key: "discovery.find-due-sources",
    });
    const drain = queue.schedules.get("processing.process-pending");
    assert.equal(drain?.cron, DRAIN_SAFETY_NET_CRON);
    assert.equal(DRAIN_SAFETY_NET_CRON, "0 * * * *");

    await jobs.stop();
    assert.equal(queue.stopped, true);
  });

  test("the scheduled drain has the same key as the drain a fetch queues", async () => {
    const { queue } = await start({
      discovery: { runSource: (id) => Promise.resolve(run(id, { listingsNewOrChanged: 1 })) },
    });
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a" });
    await queue.runNext("discovery.fetch-source");
    assert.equal(queue.jobs("processing.process-pending")[0]?.key, queue.schedules.get("processing.process-pending")?.key);
  });
});

describe("discovery.find-due-sources", () => {
  test("queues one fetch per due source, keyed by the source ID", async () => {
    const { queue } = await start({
      discovery: { findDueSources: () => Promise.resolve([source("a"), source("b")]) },
    });
    assert.equal(await queue.runScheduled("discovery.find-due-sources"), undefined);
    assert.deepEqual(queue.jobs("discovery.fetch-source"), [
      { name: "discovery.fetch-source", payload: { sourceId: "a" }, key: "a", delaySeconds: undefined },
      { name: "discovery.fetch-source", payload: { sourceId: "b" }, key: "b", delaySeconds: undefined },
    ]);
  });

  test("a source whose fetch is still waiting is not queued twice", async () => {
    const { queue } = await start({
      discovery: { findDueSources: () => Promise.resolve([source("a")]) },
    });
    await queue.runScheduled("discovery.find-due-sources");
    await queue.runScheduled("discovery.find-due-sources");
    assert.equal(queue.jobs("discovery.fetch-source").length, 1);
  });

  test("queues nothing when no source is due", async () => {
    const { queue } = await start({ discovery: { findDueSources: () => Promise.resolve([]) } });
    await queue.runScheduled("discovery.find-due-sources");
    assert.equal(queue.queued.length, 0);
  });
});

describe("discovery.fetch-source", () => {
  test("a run that found new or changed listings queues one drain", async () => {
    const fetched: string[] = [];
    const { queue } = await start({
      discovery: {
        runSource: (id) => {
          fetched.push(id);
          return Promise.resolve(run(id, { listingsFound: 3, listingsNewOrChanged: 2, listingsUnchanged: 1 }));
        },
      },
    });
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a" });
    await queue.enqueue("discovery.fetch-source", { sourceId: "b" }, { key: "b" });
    assert.equal(await queue.runNext("discovery.fetch-source"), undefined);
    assert.equal(await queue.runNext("discovery.fetch-source"), undefined);

    assert.deepEqual(fetched, ["a", "b"]);
    // Two runs with news, one drain waiting.
    assert.equal(queue.jobs("processing.process-pending").length, 1);
  });

  test("a run that found only removed listings queues a drain", async () => {
    const { queue } = await start({
      discovery: { runSource: (id) => Promise.resolve(run(id, { listingsRemoved: 1, listingsUnchanged: 4 })) },
    });
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a" });
    await queue.runNext("discovery.fetch-source");
    assert.equal(queue.jobs("processing.process-pending").length, 1);
  });

  test("a run with nothing new, changed or removed queues no drain", async () => {
    const { queue } = await start({
      discovery: { runSource: (id) => Promise.resolve(run(id, { listingsFound: 4, listingsUnchanged: 4 })) },
    });
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a" });
    assert.equal(await queue.runNext("discovery.fetch-source"), undefined);
    assert.equal(queue.queued.length, 0);
  });

  test("a failed run fails the job with the run's error and queues no drain", async () => {
    const { queue } = await start({
      discovery: {
        runSource: (id) => Promise.resolve(run(id, { status: "failed", listingsNewOrChanged: 1, error: "HTTP 503" })),
      },
    });
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a" });
    const error = await queue.runNext("discovery.fetch-source");
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 503/);
    assert.equal(queue.jobs("processing.process-pending").length, 0);
  });

  test("its policy carries the retry settings: five retries 15, 30, 60, 120 and 240 minutes apart", async () => {
    const { queue } = await start({
      discovery: { runSource: (id) => Promise.resolve(run(id, { status: "failed", error: "HTTP 503" })) },
    });
    assert.deepEqual(queue.handler("discovery.fetch-source").policy, {
      retries: 5,
      retryDelaySeconds: 15 * 60,
      retryBackoff: true,
      timeoutSeconds: 60 * 60,
      concurrency: 2,
    });

    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a" });
    const result = await queue.runWithRetries("discovery.fetch-source");
    assert.equal(result.succeeded, false);
    assert.deepEqual(
      result.failures.map((failure) => failure.attempt),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      result.waitsSeconds.map((seconds) => seconds / 60),
      [15, 30, 60, 120, 240],
    );
  });

  test("a retry that succeeds ends the retries", async () => {
    let attempts = 0;
    const { queue } = await start({
      discovery: {
        runSource: (id) => {
          attempts += 1;
          return Promise.resolve(attempts < 3 ? run(id, { status: "failed", error: "timeout" }) : run(id));
        },
      },
    });
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a" });
    const result = await queue.runWithRetries("discovery.fetch-source");
    assert.equal(result.succeeded, true);
    assert.equal(result.failures.length, 2);
    assert.equal(attempts, 3);
  });
});

describe("processing.process-pending", () => {
  test("processes until nothing is pending, and succeeds", async () => {
    const pending = outcomesInOrder([outcome("1"), outcome("2"), outcome("3")]);
    const { queue } = await start({ processNext: pending.processNext });
    await queue.enqueue("processing.process-pending", {}, { key: "pending" });
    assert.equal(await queue.runNext("processing.process-pending"), undefined);
    assert.equal(pending.calls(), 4);
  });

  test("finishes at once when nothing is pending", async () => {
    const pending = outcomesInOrder([]);
    const { queue } = await start({ processNext: pending.processNext });
    assert.equal(await queue.runScheduled("processing.process-pending"), undefined);
    assert.equal(pending.calls(), 1);
  });

  test("runs the configured number of workers side by side", async () => {
    let left = 9;
    let inFlight = 0;
    let most = 0;
    const processNext = async (): Promise<ProcessingOutcome | null> => {
      if (left === 0) return null;
      left -= 1;
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return outcome(String(left));
    };
    const { queue } = await start({ processNext, processing: { workers: 3 } });
    assert.equal(await queue.runScheduled("processing.process-pending"), undefined);
    assert.equal(left, 0);
    assert.equal(most, 3);
  });

  test("a failed raw listing stops the drain and fails the job", async () => {
    const pending = outcomesInOrder([outcome("1"), outcome("2", true), outcome("3")]);
    const { queue } = await start({ processNext: pending.processNext });
    const error = await queue.runScheduled("processing.process-pending");
    assert.ok(error instanceof Error);
    assert.match(error.message, /Raw listing 2 .*The model gave no answer/);
    // The third raw listing is left for the retry.
    assert.equal(pending.calls(), 2);
  });

  test("its policy retries five times, a minute after the first failure and doubling, with a long timeout", async () => {
    const { queue } = await start({});
    const { policy } = queue.handler("processing.process-pending");
    assert.equal(policy.retries, 5);
    assert.equal(policy.retryDelaySeconds, 60);
    assert.equal(policy.retryBackoff, true);
    assert.ok(policy.timeoutSeconds >= 60 * 60);
  });

  test("a system error from processing fails the job", async () => {
    let calls = 0;
    const processNext = (): Promise<ProcessingOutcome | null> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("connection lost")) : Promise.resolve(outcome(String(calls)));
    };
    const { queue } = await start({ processNext, processing: { workers: 2 } });
    const error = await queue.runScheduled("processing.process-pending");
    assert.ok(error instanceof Error);
    assert.equal(error.message, "connection lost");
  });

  test("stopping the queue stops the drain between raw listings, and the job fails so it is run again", async () => {
    let calls = 0;
    const queueHolder: { queue?: FakeJobQueue } = {};
    const processNext = async (): Promise<ProcessingOutcome | null> => {
      calls += 1;
      if (calls === 2) await queueHolder.queue?.stop();
      return outcome(String(calls));
    };
    const { queue } = await start({ processNext });
    queueHolder.queue = queue;
    const error = await queue.runScheduled("processing.process-pending");
    assert.ok(error instanceof Error);
    assert.match(error.message, /stopped before/);
    assert.equal(calls, 2);
  });
});

// Hands out the rounds in order, then rounds with nothing left.
function roundsInOrder(rounds: EmbedExperiencesResult[]): { embedExperiences: Catalogue["embedExperiences"]; calls: () => number } {
  let calls = 0;
  return {
    embedExperiences: () => {
      calls += 1;
      return Promise.resolve(rounds.shift() ?? { embedded: 0, failed: 0, remaining: 0 });
    },
    calls: () => calls,
  };
}

describe("catalogue.embed-experiences", () => {
  test("runs every 15 minutes under the key a drain queues it with", async () => {
    const { queue } = await start({});
    assert.equal(EMBED_SAFETY_NET_CRON, "*/15 * * * *");
    assert.deepEqual(queue.schedules.get("catalogue.embed-experiences"), {
      name: "catalogue.embed-experiences",
      cron: EMBED_SAFETY_NET_CRON,
      payload: {},
      key: "embeddings",
    });
  });

  test("embeds round after round until nothing remains, and succeeds", async () => {
    const rounds = roundsInOrder([
      { embedded: 100, failed: 0, remaining: 150 },
      { embedded: 99, failed: 1, remaining: 51 },
      { embedded: 51, failed: 0, remaining: 0 },
    ]);
    const { queue } = await start({ catalogue: { embedExperiences: rounds.embedExperiences } });
    assert.equal(await queue.runScheduled("catalogue.embed-experiences"), undefined);
    assert.equal(rounds.calls(), 3);
  });

  test("finishes at once when nothing is due", async () => {
    const rounds = roundsInOrder([]);
    const { queue } = await start({ catalogue: { embedExperiences: rounds.embedExperiences } });
    assert.equal(await queue.runScheduled("catalogue.embed-experiences"), undefined);
    assert.equal(rounds.calls(), 1);
  });

  test("a round in which the model failed on every text fails the job, so the queue tries again", async () => {
    const rounds = roundsInOrder([
      { embedded: 100, failed: 0, remaining: 3 },
      { embedded: 0, failed: 3, remaining: 3 },
      { embedded: 3, failed: 0, remaining: 0 },
    ]);
    const { queue } = await start({ catalogue: { embedExperiences: rounds.embedExperiences } });
    const error = await queue.runScheduled("catalogue.embed-experiences");
    assert.ok(error instanceof Error);
    assert.match(error.message, /failed on all 3 experiences/);
    // The third round is left for the retry.
    assert.equal(rounds.calls(), 2);
  });

  test("a system error from Catalogue fails the job", async () => {
    const { queue } = await start({
      catalogue: { embedExperiences: () => Promise.reject(new Error("connection lost")) },
    });
    const error = await queue.runScheduled("catalogue.embed-experiences");
    assert.ok(error instanceof Error);
    assert.equal(error.message, "connection lost");
  });

  test("stopping the queue stops between rounds, and the job fails so it is run again", async () => {
    let calls = 0;
    const queueHolder: { queue?: FakeJobQueue } = {};
    const embedExperiences = async (): Promise<EmbedExperiencesResult> => {
      calls += 1;
      if (calls === 2) await queueHolder.queue?.stop();
      return { embedded: 100, failed: 0, remaining: 100 };
    };
    const { queue } = await start({ catalogue: { embedExperiences } });
    queueHolder.queue = queue;
    const error = await queue.runScheduled("catalogue.embed-experiences");
    assert.ok(error instanceof Error);
    assert.match(error.message, /stopped before/);
    assert.equal(calls, 2);
  });

  test("its policy retries five times, a minute after the first failure and doubling, one job at a time", async () => {
    const { queue } = await start({});
    assert.deepEqual(queue.handler("catalogue.embed-experiences").policy, {
      retries: 5,
      retryDelaySeconds: 60,
      retryBackoff: true,
      timeoutSeconds: 30 * 60,
      concurrency: 1,
    });
  });

  test("is queued once, under its key, by a drain that processed something", async () => {
    const pending = outcomesInOrder([outcome("1"), outcome("2")]);
    const { queue } = await start({ processNext: pending.processNext });
    await queue.runScheduled("processing.process-pending");
    await queue.runScheduled("processing.process-pending");
    assert.deepEqual(queue.jobs("catalogue.embed-experiences"), [
      { name: "catalogue.embed-experiences", payload: {}, key: "embeddings", delaySeconds: undefined },
    ]);
  });

  test("is queued by a drain that processed something before a raw listing failed", async () => {
    const pending = outcomesInOrder([outcome("1"), outcome("2", true)]);
    const { queue } = await start({ processNext: pending.processNext });
    assert.ok((await queue.runScheduled("processing.process-pending")) instanceof Error);
    assert.equal(queue.jobs("catalogue.embed-experiences").length, 1);
  });

  test("is not queued by a drain that processed nothing", async () => {
    const pending = outcomesInOrder([outcome("1", true)]);
    const { queue } = await start({ processNext: pending.processNext });
    await queue.runScheduled("processing.process-pending");
    const empty = outcomesInOrder([]);
    const second = await start({ processNext: empty.processNext });
    await second.queue.runScheduled("processing.process-pending");
    assert.equal(queue.jobs("catalogue.embed-experiences").length, 0);
    assert.equal(second.queue.jobs("catalogue.embed-experiences").length, 0);
  });
});

describe("catalogue.keep-up", () => {
  test("runs on the cron of its setting, keyed by its name", async () => {
    const { queue } = await start({ catalogueSettings: { upkeepCron: "30 2 * * *" } });
    assert.deepEqual(queue.schedules.get("catalogue.keep-up"), {
      name: "catalogue.keep-up",
      cron: "30 2 * * *",
      payload: {},
      key: "catalogue.keep-up",
    });
  });

  test("runs Catalogue's upkeep once, and succeeds", async () => {
    let calls = 0;
    const keepUp = () => {
      calls += 1;
      return Promise.resolve({ past: 2, bookingsClosed: 1, sessionsGenerated: 12 });
    };
    const { queue } = await start({ catalogue: { keepUp } });
    assert.equal(await queue.runScheduled("catalogue.keep-up"), undefined);
    assert.equal(calls, 1);
  });

  test("a system error from Catalogue fails the job, and it is tried twice more a minute apart", async () => {
    let calls = 0;
    const keepUp = () => {
      calls += 1;
      return Promise.reject(new Error("connection lost"));
    };
    const { queue } = await start({ catalogue: { keepUp } });
    const error = await queue.runScheduled("catalogue.keep-up");
    assert.ok(error instanceof Error);
    assert.equal(error.message, "connection lost");
    assert.deepEqual(queue.handler("catalogue.keep-up").policy, {
      retries: 2,
      retryDelaySeconds: 60,
      retryBackoff: false,
      timeoutSeconds: 30 * 60,
      concurrency: 1,
    });
    assert.equal(calls, 1);
  });
});
