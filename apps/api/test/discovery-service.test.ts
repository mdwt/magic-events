import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { Catalogue, Location } from "../src/core/catalogue/ports.ts";
import { addMonths, sourcingWindow } from "../src/core/discovery/fetching.ts";
import type {
  DiscoveryRepository,
  FetchedListing,
  FetchInput,
  FetchResult,
  KnownListing,
  ListingVersion,
  RunOutcome,
  SaveSourceInput,
  Source,
  SourceFetcher,
  SourceForRun,
} from "../src/core/discovery/ports.ts";
import type { LastRun } from "../src/core/discovery/due.ts";
import { DiscoveryService } from "../src/core/discovery/service.ts";
import { AppError } from "../src/core/shared/errors.ts";
import type { DomainEvent, DomainEventPublisher } from "../src/core/shared/domain-events.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import type { DiscoverySettings } from "../src/core/shared/settings.ts";

// The Discovery service with fakes: an in-memory repository, fake adapters and a clock the test moves.

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

const hermanus: Location = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Hermanus",
  slug: "hermanus",
  country: "South Africa",
  region: "Western Cape",
  timezone: "Africa/Johannesburg",
  latitude: -34.4187,
  longitude: 19.2345,
};

// A second location, so a test can tell one location's sources from another's.
const stanford: Location = {
  ...hermanus,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Stanford",
  slug: "stanford",
};

const notUsed = () => Promise.reject(new Error("not used"));

// A Catalogue that knows Hermanus and Stanford. Discovery uses nothing but getLocation.
const catalogue: Catalogue = {
  searchExperiences: notUsed,
  saveLocation: notUsed,
  getLocation: (by) => {
    const found = [hermanus, stanford].find((one) => ("slug" in by ? one.slug === by.slug : one.id === by.id));
    return Promise.resolve(found ?? null);
  },
  getExperience: notUsed,
  findExperiencesByListing: notUsed,
  findMatchCandidates: notUsed,
  saveExperience: notUsed,
  removeSourceLink: notUsed,
  getChangesSince: notUsed,
  keepUp: notUsed,
  embedExperiences: notUsed,
};

const settings: DiscoverySettings = {
  defaultFetchIntervalHours: 24,
  defaultMissedRunsBeforeRemoval: 3,
  defaultMaxProcessingAttempts: 5,
  scheduleCron: "*/15 * * * *",
  runTimeoutMinutes: 60,
  fetchTimeoutSeconds: 30,
  userAgent: "test",
  fetchRetries: 5,
  fetchRetryBackoffMinutes: 15,
  horizonMonths: 24,
  credentials: { TEST_API_KEY: "secret-key" },
};

interface FakeRun extends Omit<RunOutcome, "status" | "finishedAt"> {
  id: string;
  sourceId: string;
  status: LastRun["status"];
  startedAt: Date;
  finishedAt: Date | null;
}

interface FakeListing extends KnownListing {
  sourceId: string;
  lastSeenRunId: string;
}

interface FakeRawListing {
  id: string;
  listingId: string;
  runId: string;
  kind: "listing" | "removed";
  content: string | null;
  status: "pending" | "processed" | "failed" | "superseded";
  attempts?: number;
  error?: string | null;
}

// Storage as the Discovery repository keeps it, in memory, with the same rules for missed listings.
function memoryRepository() {
  const sources = new Map<string, SourceForRun>();
  const runs: FakeRun[] = [];
  const listings: FakeListing[] = [];
  const rawListings: FakeRawListing[] = [];
  const syncStates: Record<string, unknown>[] = [];
  // Every domain event the repository appended, in order.
  const appended: DomainEvent[] = [];
  let failSaveAfter = Infinity;

  function append<E extends DomainEvent>(event: E): E {
    appended.push(event);
    return event;
  }

  function capture(listingId: string, version: ListingVersion): DomainEvent<"raw_listing.captured"> {
    const id = randomUUID();
    rawListings.push({ id, listingId, runId: version.runId, kind: "listing", content: version.content, status: "pending" });
    return append({
      id: randomUUID(),
      type: "raw_listing.captured",
      resourceId: id,
      data: { listing_id: listingId, run_id: version.runId, kind: "listing" },
      recordedAt: version.fetchedAt.toISOString(),
    });
  }

  const repository: DiscoveryRepository = {
    upsertSource(input) {
      const saved: SourceForRun = { id: randomUUID(), ...input, syncState: {} };
      sources.set(saved.id, saved);
      return Promise.resolve(saved);
    },
    listSources: () => Promise.resolve([...sources.values()]),
    findSource: (id) => Promise.resolve(sources.get(id) ?? null),
    findLastRuns(sourceIds) {
      const bySource: Record<string, LastRun | null> = {};
      for (const sourceId of sourceIds) {
        const [newest] = runs
          .filter((one) => one.sourceId === sourceId)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        bySource[sourceId] = newest ? { id: newest.id, status: newest.status, startedAt: newest.startedAt } : null;
      }
      return Promise.resolve(bySource);
    },
    closeStaleRuns({ sourceId, startedBefore, finishedAt, error }) {
      const stale = runs.filter(
        (one) =>
          one.status === "running" &&
          one.startedAt < startedBefore &&
          (sourceId === undefined || one.sourceId === sourceId),
      );
      for (const one of stale) Object.assign(one, { status: "failed", finishedAt, error });
      return Promise.resolve(stale.length);
    },
    saveSyncState(sourceId, syncState) {
      syncStates.push(syncState);
      const source = sources.get(sourceId);
      if (source) source.syncState = syncState;
      return Promise.resolve();
    },
    startRun(sourceId, startedAt) {
      const id = randomUUID();
      runs.push({
        id,
        sourceId,
        startedAt,
        status: "running",
        complete: false,
        listingsFound: 0,
        listingsNewOrChanged: 0,
        listingsUnchanged: 0,
        error: null,
        finishedAt: null,
      });
      return Promise.resolve(id);
    },
    finishRun(runId, outcome) {
      const found = runs.find((one) => one.id === runId);
      if (found) Object.assign(found, outcome);
      return Promise.resolve();
    },
    findListings: (sourceId) => Promise.resolve(listings.filter((one) => one.sourceId === sourceId)),
    saveNewListing(input) {
      if (rawListings.length >= failSaveAfter) return Promise.reject(new Error("The database went away"));
      const id = randomUUID();
      listings.push({
        id,
        sourceId: input.sourceId,
        sourceListingId: input.sourceListingId,
        fingerprint: input.fingerprint,
        state: "listed",
        lastSeenRunId: input.runId,
      });
      return Promise.resolve(capture(id, input));
    },
    saveListingVersion(input) {
      const found = listings.find((one) => one.id === input.listingId);
      if (found) Object.assign(found, { fingerprint: input.fingerprint, state: "listed", lastSeenRunId: input.runId });
      return Promise.resolve(capture(input.listingId, input));
    },
    markListingsSeen(listingIds, runId) {
      for (const one of listings) if (listingIds.includes(one.id)) one.lastSeenRunId = runId;
      return Promise.resolve();
    },
    findMissedListings(sourceId, missedRuns) {
      const missed = listings.filter((one) => {
        if (one.sourceId !== sourceId || one.state !== "listed") return false;
        const seen = runs.find((r) => r.id === one.lastSeenRunId);
        if (!seen) return false;
        const after = runs.filter(
          (r) => r.sourceId === sourceId && r.status === "succeeded" && r.complete && r.startedAt > seen.startedAt,
        );
        return after.length >= missedRuns;
      });
      return Promise.resolve(missed.map((one) => one.id));
    },
    removeListings(listingIds, runId, removedAt) {
      const events: DomainEvent<"raw_listing.captured">[] = [];
      for (const one of listings) {
        if (!listingIds.includes(one.id)) continue;
        one.state = "removed";
        const id = randomUUID();
        rawListings.push({ id, listingId: one.id, runId, kind: "removed", content: null, status: "pending" });
        events.push(
          append({
            id: randomUUID(),
            type: "raw_listing.captured",
            resourceId: id,
            data: { listing_id: one.id, run_id: runId, kind: "removed" },
            recordedAt: removedAt.toISOString(),
          }),
        );
      }
      return Promise.resolve(events);
    },
    // The oldest pending raw listing, and the newest version of its listing, in the order they were saved.
    lockOldestPendingRawListing() {
      const oldest = rawListings.find((one) => one.status === "pending");
      if (!oldest) return Promise.resolve(null);
      const latest = rawListings.filter((one) => one.listingId === oldest.listingId).at(-1) ?? oldest;
      return Promise.resolve({
        rawListing: {
          id: oldest.id,
          listingId: oldest.listingId,
          kind: oldest.kind,
          source: { id: "source-1", name: "Organiser pages", kind: "web_page", priority: 0, locationId: hermanus.id },
          url: null,
          contentType: "text/html",
          content: oldest.content,
          fetchedAt: "2026-11-23T08:00:00.000Z",
          attempts: 0,
        },
        latestRawListingId: latest.id,
      });
    },
    supersedeOlderVersions({ listingId, newerRawListingId }) {
      const newer = rawListings.findIndex((one) => one.id === newerRawListingId);
      const older = rawListings
        .slice(0, newer)
        .filter((one) => one.listingId === listingId && (one.status === "pending" || one.status === "failed"));
      return Promise.resolve(
        older.map((one) => {
          one.status = "superseded";
          return append({
            id: randomUUID(),
            type: "raw_listing.superseded",
            resourceId: one.id,
            data: { listing_id: listingId, raw_listing_id: newerRawListingId },
            recordedAt: "2026-11-23T08:00:00.000Z",
          });
        }),
      );
    },
    findRawListingForMark: (id) =>
      Promise.resolve({ id, listingId: "listing-1", status: "pending", attempts: 1, maxProcessingAttempts: 3 }),
    markRawListingProcessed: ({ id, listingId }) =>
      Promise.resolve(
        append({
          id: randomUUID(),
          type: "raw_listing.processed",
          resourceId: id,
          data: { listing_id: listingId },
          recordedAt: "2026-11-23T08:00:00.000Z",
        }),
      ),
    markRawListingFailed: ({ id, listingId, attempts, error, willRetry }) =>
      Promise.resolve(
        append({
          id: randomUUID(),
          type: "raw_listing.failed",
          resourceId: id,
          data: { listing_id: listingId, error, attempt: attempts, will_retry: willRetry },
          recordedAt: "2026-11-23T08:00:00.000Z",
        }),
      ),
    findListingPriorities: (ids) => Promise.resolve(Object.fromEntries(ids.map((id) => [id, 10]))),
    findListing(listingId) {
      const found = listings.find((one) => one.id === listingId);
      const source = found && sources.get(found.sourceId);
      if (!found || !source) return Promise.resolve(null);
      const { id, state } = found;
      return Promise.resolve({ id, sourceId: source.id, sourceName: source.name, url: null, state });
    },
    findListingIds: (ids) => Promise.resolve(listings.filter((one) => ids.includes(one.id)).map((one) => one.id)),
    // The repository's rules: each selected, listed listing's latest version, unless it is pending or removed.
    requeueLatestVersions(selection) {
      const selected = listings.filter((one) => {
        if (one.state !== "listed") return false;
        if ("listingIds" in selection) return selection.listingIds.includes(one.id);
        if ("sourceId" in selection) return one.sourceId === selection.sourceId;
        return sources.get(one.sourceId)?.locationId === selection.locationId;
      });
      const requeued: string[] = [];
      for (const one of selected) {
        const latest = rawListings.filter((raw) => raw.listingId === one.id).at(-1);
        if (!latest || latest.status === "pending" || latest.kind === "removed") continue;
        Object.assign(latest, { status: "pending", attempts: 0, error: null });
        requeued.push(one.id);
      }
      return Promise.resolve(requeued);
    },
  };

  return {
    repository,
    runs,
    listings,
    rawListings,
    syncStates,
    appended,
    failSavesAfter(count: number) {
      failSaveAfter = count;
    },
  };
}

// An adapter that returns what the test hands it next, and remembers what it was called with.
function fakeFetcher(kind = "web_page") {
  const calls: FetchInput[] = [];
  let next: () => Promise<FetchResult> = () => Promise.resolve({ listings: [], complete: true, syncState: {} });
  const fetcher: SourceFetcher = {
    kind,
    fetch(input) {
      calls.push(input);
      return next();
    },
  };
  return {
    fetcher,
    calls,
    returns(listings: FetchedListing[], complete = true, syncState: Record<string, unknown> = {}) {
      next = () => Promise.resolve({ listings, complete, syncState });
    },
    fails(message: string) {
      next = () => Promise.reject(new Error(message));
    },
  };
}

function page(id: string, content: string, fingerprintOf?: string): FetchedListing {
  return {
    sourceListingId: id,
    url: id,
    contentType: "text/html",
    content,
    ...(fingerprintOf === undefined ? {} : { fingerprintOf }),
  };
}

function setup(options: { fetchers?: SourceFetcher[]; start?: string } = {}) {
  const memory = memoryRepository();
  const adapter = fakeFetcher();
  let now = new Date(options.start ?? "2026-11-23T08:00:00Z");
  // A publisher that records what it is handed.
  const published: DomainEvent[] = [];
  const events: DomainEventPublisher = {
    publish(event) {
      published.push(event);
    },
  };
  const service = new DiscoveryService({
    repository: memory.repository,
    events,
    catalogue,
    fetchers: options.fetchers ?? [adapter.fetcher],
    settings,
    logger: silent,
    clock: () => now,
  });
  return {
    service,
    memory,
    adapter,
    published,
    // A day later, so each run starts after the one before.
    nextDay: () => {
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    },
    later: (minutes: number) => {
      now = new Date(now.getTime() + minutes * 60 * 1000);
    },
    source: (input: Partial<SaveSourceInput> = {}): Promise<Source> =>
      service.saveSource({ name: "Organiser pages", kind: "web_page", locationSlug: "hermanus", ...input }),
  };
}

const quicket: SaveSourceInput = {
  name: "Quicket",
  kind: "quicket",
  locationSlug: "hermanus",
  credentialsSetting: "QUICKET_API_KEY",
};

describe("DiscoveryService.saveSource", () => {
  test("gives a source left without them the defaults from the settings", async () => {
    const { service } = setup();
    const source = await service.saveSource(quicket);

    assert.equal(source.locationId, hermanus.id);
    const { id, ...rest } = source;
    assert.ok(id);
    assert.deepEqual(rest, {
      name: "Quicket",
      kind: "quicket",
      locationId: hermanus.id,
      settings: {},
      credentialsSetting: "QUICKET_API_KEY",
      priority: 0,
      fetchIntervalHours: 24,
      missedRunsBeforeRemoval: 3,
      maxProcessingAttempts: 5,
      active: true,
      syncState: {},
    });
  });

  test("keeps the values the source is given", async () => {
    const { service } = setup();
    const source = await service.saveSource({
      ...quicket,
      fetchIntervalHours: 6,
      missedRunsBeforeRemoval: 1,
      maxProcessingAttempts: 2,
      priority: 20,
      active: false,
    });

    assert.equal(source.fetchIntervalHours, 6);
    assert.equal(source.missedRunsBeforeRemoval, 1);
    assert.equal(source.maxProcessingAttempts, 2);
    assert.equal(source.priority, 20);
    assert.equal(source.active, false);
  });

  test("accepts each of the five kinds", async () => {
    const { service } = setup();
    for (const kind of ["quicket", "ticketmaster", "rss_feed", "pdf_calendar", "web_page"]) {
      const source = await service.saveSource({ ...quicket, kind });
      assert.equal(source.kind, kind);
    }
  });

  test("refuses an unknown kind with invalid_input and saves nothing", async () => {
    const { service } = setup();
    await assert.rejects(
      service.saveSource({ ...quicket, kind: "facebook" }),
      (error) => error instanceof AppError && error.code === "invalid_input" && error.details?.[0]?.path === "kind",
    );
    assert.equal((await service.listSources()).length, 0);
  });

  test("refuses an unknown location with not_found and saves nothing", async () => {
    const { service } = setup();
    await assert.rejects(
      service.saveSource({ ...quicket, locationSlug: "atlantis" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal((await service.listSources()).length, 0);
  });
});

describe("DiscoveryService.runSource: listings", () => {
  test("saves new listings, counts unchanged ones, and saves a changed one again", async () => {
    const { service, memory, adapter, published, nextDay, source } = setup();
    const saved = await source();

    adapter.returns([page("a", "<p>A</p>"), page("b", "<p>B</p>")]);
    const first = await service.runSource(saved.id);
    assert.equal(first.status, "succeeded");
    assert.equal(first.complete, true);
    assert.deepEqual(
      [first.listingsFound, first.listingsNewOrChanged, first.listingsUnchanged, first.listingsRemoved],
      [2, 2, 0, 0],
    );

    nextDay();
    adapter.returns([page("a", "<p>A</p>"), page("b", "<p>B, with a new date</p>"), page("c", "<p>C</p>")]);
    const second = await service.runSource(saved.id);
    assert.deepEqual([second.listingsFound, second.listingsNewOrChanged, second.listingsUnchanged], [3, 2, 1]);

    assert.equal(memory.listings.length, 3);
    // a once, b twice, c once.
    assert.deepEqual(
      memory.rawListings.map((raw) => raw.content),
      ["<p>A</p>", "<p>B</p>", "<p>B, with a new date</p>", "<p>C</p>"],
    );
    // Each new raw listing's raw_listing.captured was published once, as the repository appended it.
    assert.deepEqual(published, memory.appended);
    assert.equal(published.length, 4);
    const changed = memory.rawListings[2];
    const forChanged = published.filter((event) => event.resourceId === changed?.id);
    assert.equal(forChanged.length, 1);
    assert.equal(forChanged[0]?.type, "raw_listing.captured");
    assert.deepEqual(forChanged[0].data, { listing_id: changed?.listingId, run_id: second.runId, kind: "listing" });
    // The unchanged listing was seen by the second run.
    const a = memory.listings.find((one) => one.sourceListingId === "a");
    assert.equal(a?.lastSeenRunId, second.runId);
    // The run is closed with the same counts.
    const run = memory.runs.find((one) => one.id === second.runId);
    assert.equal(run?.status, "succeeded");
    assert.equal(run.listingsNewOrChanged, 2);
    assert.equal(run.error, null);
  });

  test("takes the fingerprint from fingerprintOf when the adapter gives it", async () => {
    const { service, adapter, nextDay, source } = setup();
    const saved = await source();

    adapter.returns([page("a", "<p data-token='1'>A</p>", "A")]);
    await service.runSource(saved.id);
    nextDay();
    adapter.returns([page("a", "<p data-token='2'>A</p>", "A")]);
    const second = await service.runSource(saved.id);

    assert.equal(second.listingsUnchanged, 1);
    assert.equal(second.listingsNewOrChanged, 0);
  });

  test("counts a listing the adapter returns twice once", async () => {
    const { service, memory, adapter, source } = setup();
    const saved = await source();
    adapter.returns([page("a", "first"), page("a", "second")]);

    const summary = await service.runSource(saved.id);

    assert.equal(summary.listingsFound, 1);
    assert.equal(memory.rawListings.length, 1);
  });

  test("saves the adapter's sync state for the next run, and hands it back", async () => {
    const { service, memory, adapter, nextDay, source } = setup();
    const saved = await source();

    adapter.returns([], true, { lastModified: "2026-11-23T08:00:00Z" });
    await service.runSource(saved.id);
    nextDay();
    await service.runSource(saved.id);

    assert.deepEqual(memory.syncStates[0], { lastModified: "2026-11-23T08:00:00Z" });
    assert.deepEqual(adapter.calls[1]?.syncState, { lastModified: "2026-11-23T08:00:00Z" });
  });
});

describe("DiscoveryService.runSource: failures are failed runs", () => {
  test("an adapter that throws gives a failed run with its error", async () => {
    const { service, memory, adapter, source } = setup();
    const saved = await source();
    adapter.fails("GET https://example.com answered 500 Internal Server Error");

    const summary = await service.runSource(saved.id);

    assert.equal(summary.status, "failed");
    assert.equal(summary.error, "GET https://example.com answered 500 Internal Server Error");
    assert.equal(memory.runs[0]?.status, "failed");
    assert.equal(memory.runs[0].error, summary.error);
    assert.equal(memory.syncStates.length, 0);
  });

  test("a source of a kind no adapter fetches gives a failed run", async () => {
    const { service, memory, adapter, source } = setup();
    const saved = await source({ kind: "ticketmaster" });

    const summary = await service.runSource(saved.id);

    assert.equal(summary.status, "failed");
    assert.match(summary.error ?? "", /No adapter fetches sources of the kind "ticketmaster"/);
    assert.equal(memory.runs.length, 1);
    assert.equal(adapter.calls.length, 0);
  });

  test("a source whose API key is not set gives a failed run and the adapter is not called", async () => {
    const { service, adapter, source } = setup();
    const saved = await source({ credentialsSetting: "MISSING_API_KEY" });

    const summary = await service.runSource(saved.id);

    assert.equal(summary.status, "failed");
    assert.match(summary.error ?? "", /MISSING_API_KEY/);
    assert.equal(adapter.calls.length, 0);
  });

  test("hands the adapter the key from the setting the source names", async () => {
    const { service, adapter, source } = setup();
    const saved = await source({ credentialsSetting: "TEST_API_KEY", settings: { urls: ["https://example.com/"] } });

    await service.runSource(saved.id);

    assert.equal(adapter.calls[0]?.credentials, "secret-key");
    assert.deepEqual(adapter.calls[0].settings, { urls: ["https://example.com/"] });
    assert.equal(adapter.calls[0].location.id, hermanus.id);
  });

  test("keeps the listings saved before a run failed", async () => {
    const { service, memory, adapter, published, source } = setup();
    const saved = await source();
    memory.failSavesAfter(1);
    adapter.returns([page("a", "A"), page("b", "B")]);

    const summary = await service.runSource(saved.id);

    assert.equal(summary.status, "failed");
    assert.equal(summary.error, "The database went away");
    assert.equal(summary.listingsNewOrChanged, 1);
    assert.equal(memory.rawListings.length, 1);
    assert.equal(published.length, 1);
  });

  test("an unknown source is not_found", async () => {
    const { service } = setup();
    await assert.rejects(
      service.runSource(randomUUID()),
      (error) => error instanceof AppError && error.code === "not_found",
    );
  });
});

describe("DiscoveryService.runSource: listings that disappear", () => {
  test("removes a listing after the configured number of successful, complete runs without it", async () => {
    const { service, memory, adapter, published, nextDay, source } = setup();
    const saved = await source({ missedRunsBeforeRemoval: 2 });

    adapter.returns([page("a", "A"), page("b", "B")]);
    await service.runSource(saved.id);

    nextDay();
    adapter.returns([page("a", "A")]);
    const firstMiss = await service.runSource(saved.id);
    assert.equal(firstMiss.listingsRemoved, 0);
    assert.equal(memory.listings.find((one) => one.sourceListingId === "b")?.state, "listed");

    nextDay();
    const secondMiss = await service.runSource(saved.id);
    assert.equal(secondMiss.listingsRemoved, 1);
    const b = memory.listings.find((one) => one.sourceListingId === "b");
    assert.equal(b?.state, "removed");
    const removed = memory.rawListings.at(-1);
    assert.ok(removed);
    assert.deepEqual({ ...removed, id: "" }, {
      id: "",
      listingId: b.id,
      runId: secondMiss.runId,
      kind: "removed",
      content: null,
      status: "pending",
    });
    const forRemoved = published.filter((event) => event.resourceId === removed.id);
    assert.equal(forRemoved.length, 1);
    assert.equal(forRemoved[0]?.type, "raw_listing.captured");
    assert.deepEqual(forRemoved[0].data, { listing_id: b.id, run_id: secondMiss.runId, kind: "removed" });
    assert.deepEqual(published, memory.appended);
  });

  test("never counts an incomplete run", async () => {
    const { service, memory, adapter, nextDay, source } = setup();
    const saved = await source({ missedRunsBeforeRemoval: 1 });
    adapter.returns([page("a", "A")]);
    await service.runSource(saved.id);

    for (let day = 0; day < 3; day += 1) {
      nextDay();
      adapter.returns([], false);
      const summary = await service.runSource(saved.id);
      assert.equal(summary.listingsRemoved, 0);
    }
    assert.equal(memory.listings[0]?.state, "listed");
  });

  test("never counts a failed run", async () => {
    const { service, memory, adapter, nextDay, source } = setup();
    const saved = await source({ missedRunsBeforeRemoval: 2 });
    adapter.returns([page("a", "A")]);
    await service.runSource(saved.id);

    nextDay();
    adapter.fails("timed out");
    await service.runSource(saved.id);
    nextDay();
    adapter.returns([]);
    const summary = await service.runSource(saved.id);

    // One failed run and one complete run: only one miss so far.
    assert.equal(summary.listingsRemoved, 0);
    assert.equal(memory.listings[0]?.state, "listed");
  });

  test("a listing that comes back is listed again and saved as a new raw listing", async () => {
    const { service, memory, adapter, nextDay, source } = setup();
    const saved = await source({ missedRunsBeforeRemoval: 1 });
    adapter.returns([page("a", "A")]);
    await service.runSource(saved.id);
    nextDay();
    adapter.returns([]);
    await service.runSource(saved.id);
    assert.equal(memory.listings[0]?.state, "removed");

    nextDay();
    // The same content as before it was removed.
    adapter.returns([page("a", "A")]);
    const back = await service.runSource(saved.id);

    assert.equal(back.listingsNewOrChanged, 1);
    assert.equal(memory.listings[0].state, "listed");
    assert.deepEqual(
      memory.rawListings.map((raw) => raw.kind),
      ["listing", "removed", "listing"],
    );
  });
});

describe("DiscoveryService: due sources and the sourcing window", () => {
  test("finds the active sources that never ran or whose interval has passed since their last run started", async () => {
    const { service, adapter, later, source } = setup({ start: "2026-11-23T08:00:00Z" });
    const steady = await source({ name: "Steady", fetchIntervalHours: 24 });
    const flaky = await source({ name: "Flaky", fetchIntervalHours: 24 });
    await source({ name: "Never ran" });
    await source({ name: "Inactive", active: false });

    adapter.fails("GET https://example.com answered 503 Service Unavailable");
    await service.runSource(flaky.id);
    adapter.returns([]);
    await service.runSource(steady.id);

    const names = async () => (await service.findDueSources()).map((one) => one.name).sort();
    // A failed run waits for its interval like any other: retrying is the job queue's work.
    assert.deepEqual(await names(), ["Never ran"]);
    later(24 * 60 - 1);
    assert.deepEqual(await names(), ["Never ran"]);
    later(1);
    assert.deepEqual(await names(), ["Flaky", "Never ran", "Steady"]);
  });

  test("a run in progress makes its source not due, until it is past the run timeout", async () => {
    const { service, memory, later, source } = setup({ start: "2026-11-23T08:00:00Z" });
    const saved = await source({ fetchIntervalHours: 1 });
    // A run a crash left running.
    await memory.repository.startRun(saved.id, new Date("2026-11-23T08:00:00Z"));

    later(60);
    assert.deepEqual(await service.findDueSources(), []);
    later(1);
    const due = await service.findDueSources();

    assert.deepEqual(
      due.map((one) => one.id),
      [saved.id],
    );
    assert.equal(memory.runs[0]?.status, "failed");
    assert.equal(memory.runs[0].error, "The run did not finish.");
  });

  test("runSource does not start a second run of a source that is being fetched", async () => {
    const { service, memory, adapter, later, source } = setup({ start: "2026-11-23T08:00:00Z" });
    const saved = await source();
    const running = await memory.repository.startRun(saved.id, new Date("2026-11-23T08:00:00Z"));

    later(30);
    const summary = await service.runSource(saved.id);

    assert.equal(summary.status, "failed");
    assert.equal(summary.runId, running);
    assert.equal(summary.error, "The source is already being fetched.");
    assert.equal(memory.runs.length, 1);
    assert.equal(memory.runs[0]?.status, "running");
    assert.equal(adapter.calls.length, 0);
  });

  test("runSource closes its source's run that did not finish, then fetches", async () => {
    const { service, memory, adapter, later, source } = setup({ start: "2026-11-23T08:00:00Z" });
    const saved = await source();
    await memory.repository.startRun(saved.id, new Date("2026-11-23T08:00:00Z"));

    later(61);
    const summary = await service.runSource(saved.id);

    assert.equal(summary.status, "succeeded");
    assert.equal(memory.runs[0]?.status, "failed");
    assert.equal(memory.runs[0].error, "The run did not finish.");
    assert.equal(adapter.calls.length, 1);
  });

  test("a source run by hand runs whether or not it is due", async () => {
    const { service, adapter, source } = setup();
    const saved = await source();
    await service.runSource(saved.id);
    await service.runSource(saved.id);
    assert.equal(adapter.calls.length, 2);
  });

  test("hands the adapter today to the horizon, in the location's time zone", async () => {
    // 23:30 UTC is already the 24th in Hermanus.
    const { service, adapter, source } = setup({ start: "2026-11-23T23:30:00Z" });
    const saved = await source();

    await service.runSource(saved.id);

    assert.deepEqual(adapter.calls[0]?.window, { from: "2026-11-24", to: "2028-11-24" });
  });

  test("a month without the day ends on its last day", () => {
    assert.equal(addMonths("2026-08-31", 6), "2027-02-28");
    assert.equal(addMonths("2027-08-31", 6), "2028-02-29");
    assert.equal(addMonths("2026-11-23", 24), "2028-11-23");
    assert.deepEqual(sourcingWindow(new Date("2026-06-30T21:59:00Z"), "Africa/Johannesburg", 1), {
      from: "2026-06-30",
      to: "2026-07-30",
    });
  });
});

describe("DiscoveryService: claiming and marking raw listings", () => {
  test("claims the latest version of a listing and publishes the superseded event of the older one", async () => {
    const { service, memory, adapter, published, nextDay, source } = setup();
    const saved = await source();
    adapter.returns([page("a", "first")]);
    await service.runSource(saved.id);
    nextDay();
    adapter.returns([page("a", "second")]);
    await service.runSource(saved.id);
    const [older, newer] = memory.rawListings;
    assert.ok(older && newer);
    published.length = 0;

    const claim = await service.claimPendingRawListing();

    assert.equal(claim?.id, newer.id);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.type, "raw_listing.superseded");
    assert.equal(published[0].resourceId, older.id);
    assert.deepEqual(published[0].data, { listing_id: older.listingId, raw_listing_id: newer.id });
  });

  test("marking processed publishes raw_listing.processed once", async () => {
    const { service, published } = setup();
    await service.markRawListingProcessed("raw-1");
    assert.equal(published.length, 1);
    assert.equal(published[0]?.type, "raw_listing.processed");
    assert.equal(published[0].resourceId, "raw-1");
    assert.deepEqual(published[0].data, { listing_id: "listing-1" });
  });

  test("a failed attempt below the max goes back to pending, and raw_listing.failed is published once", async () => {
    const { service, published } = setup();
    // The fake raw listing has had one attempt, of three.
    assert.deepEqual(await service.markRawListingFailed("raw-1", "wrong shape"), { attempts: 2, willRetry: true });
    assert.equal(published.length, 1);
    assert.equal(published[0]?.type, "raw_listing.failed");
    assert.equal(published[0].resourceId, "raw-1");
    assert.deepEqual(published[0].data, { listing_id: "listing-1", error: "wrong shape", attempt: 2, will_retry: true });
  });

  test("asks for no priorities when no listing is given", async () => {
    const { service } = setup();
    assert.deepEqual(await service.getListingPriorities([]), {});
    assert.deepEqual(await service.getListingPriorities(["a", "a"]), { a: 10 });
  });
});

describe("DiscoveryService.runLocation", () => {
  test("fetches every active source of the location, one after another, and no other location's", async () => {
    const { service, adapter, source } = setup();
    const pages = await source({ name: "Organiser pages" });
    const festival = await source({ name: "Whale festival" });
    await source({ name: "Old pages", active: false });
    await source({ name: "Stanford pages", locationSlug: "stanford" });
    adapter.returns([page("a", "<p>A</p>")]);

    const runs = await service.runLocation("hermanus");

    assert.deepEqual(
      runs.map((run) => [run.sourceName, run.status, run.listingsNewOrChanged]),
      [
        ["Organiser pages", "succeeded", 1],
        ["Whale festival", "succeeded", 1],
      ],
    );
    assert.deepEqual(
      runs.map((run) => run.sourceId),
      [pages.id, festival.id],
    );
    assert.equal(adapter.calls.length, 2);
  });

  test("refuses an unknown location with not_found and fetches nothing", async () => {
    const { service, adapter, source } = setup();
    await source();
    await assert.rejects(
      service.runLocation("atlantis"),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal(adapter.calls.length, 0);
  });
});

// Two listings of a Hermanus source and one of a Stanford source, each fetched once and processed.
async function processedListings() {
  const context = setup();
  const { service, memory, adapter, source } = context;
  const pages = await source();
  adapter.returns([page("a", "<p>A</p>"), page("b", "<p>B</p>")]);
  await service.runSource(pages.id);
  const stanfordPages = await source({ name: "Stanford pages", locationSlug: "stanford" });
  adapter.returns([page("c", "<p>C</p>")]);
  await service.runSource(stanfordPages.id);
  for (const raw of memory.rawListings) raw.status = "processed";
  const [a, b, c] = memory.listings;
  assert.ok(a && b && c);
  context.published.length = 0;
  // The latest version of a listing: the fake keeps them in the order they were saved.
  const latest = (listingId: string) => memory.rawListings.filter((raw) => raw.listingId === listingId).at(-1);
  return { ...context, pages, stanfordPages, a, b, c, latest };
}

describe("DiscoveryService.requeueListings", () => {
  test("sends chosen listings back: the latest version is pending again, with no attempts and no error", async () => {
    const { service, a, b, latest } = await processedListings();
    Object.assign(latest(a.id) ?? {}, { status: "failed", attempts: 3, error: "wrong shape" });

    assert.deepEqual(await service.requeueListings({ listingIds: [a.id] }), { requeued: 1, listingIds: [a.id] });

    const again = latest(a.id);
    assert.deepEqual(
      { status: again?.status, attempts: again?.attempts, error: again?.error },
      { status: "pending", attempts: 0, error: null },
    );
    assert.equal(latest(b.id)?.status, "processed");
  });

  test("sends back every listing of a source, and not another source's", async () => {
    const { service, pages, a, b, c, latest } = await processedListings();
    const result = await service.requeueListings({ sourceId: pages.id });
    assert.equal(result.requeued, 2);
    assert.deepEqual([...result.listingIds].sort(), [a.id, b.id].sort());
    assert.equal(latest(c.id)?.status, "processed");
  });

  test("sends back every listing of a location, and not another location's", async () => {
    const { service, a, c, latest } = await processedListings();
    assert.deepEqual(await service.requeueListings({ locationId: stanford.id }), { requeued: 1, listingIds: [c.id] });
    assert.equal(latest(a.id)?.status, "processed");
  });

  test("leaves a latest version that is already pending as it is, and does not count it", async () => {
    const { service, pages, a, b, latest } = await processedListings();
    Object.assign(latest(a.id) ?? {}, { status: "pending", attempts: 1, error: "timed out" });

    assert.deepEqual(await service.requeueListings({ sourceId: pages.id }), { requeued: 1, listingIds: [b.id] });
    const left = latest(a.id);
    assert.deepEqual(
      { status: left?.status, attempts: left?.attempts, error: left?.error },
      { status: "pending", attempts: 1, error: "timed out" },
    );
  });

  test("skips a removed listing and a listing whose latest version is of kind removed", async () => {
    const { service, memory, pages, a, b } = await processedListings();
    a.state = "removed";
    memory.rawListings.push({
      id: randomUUID(),
      listingId: b.id,
      runId: randomUUID(),
      kind: "removed",
      content: null,
      status: "processed",
    });

    assert.deepEqual(await service.requeueListings({ sourceId: pages.id }), { requeued: 0, listingIds: [] });
    assert.deepEqual(await service.requeueListings({ listingIds: [a.id, b.id] }), { requeued: 0, listingIds: [] });
  });

  test("sends back only the latest version, never an older one", async () => {
    const { service, memory, a, latest } = await processedListings();
    const older = latest(a.id);
    assert.ok(older);
    older.status = "failed";
    memory.rawListings.push({
      id: randomUUID(),
      listingId: a.id,
      runId: randomUUID(),
      kind: "listing",
      content: "<p>A, changed</p>",
      status: "processed",
    });

    await service.requeueListings({ listingIds: [a.id] });

    assert.equal(older.status, "failed");
    assert.equal(latest(a.id)?.status, "pending");
  });

  test("counts a listing named twice once, and sends nothing back for no listings", async () => {
    const { service, a } = await processedListings();
    assert.deepEqual(await service.requeueListings({ listingIds: [a.id, a.id] }), { requeued: 1, listingIds: [a.id] });
    assert.deepEqual(await service.requeueListings({ listingIds: [] }), { requeued: 0, listingIds: [] });
  });

  test("refuses unknown listings, sources and locations with not_found, and sends nothing back", async () => {
    const { service, memory, a } = await processedListings();
    const notFound = (error: unknown) => error instanceof AppError && error.code === "not_found";
    await assert.rejects(service.requeueListings({ listingIds: [a.id, randomUUID()] }), notFound);
    await assert.rejects(service.requeueListings({ sourceId: randomUUID() }), notFound);
    await assert.rejects(service.requeueListings({ locationId: randomUUID() }), notFound);
    assert.ok(memory.rawListings.every((raw) => raw.status === "processed"));
  });

  test("publishes no domain event", async () => {
    const { service, pages, published } = await processedListings();
    await service.requeueListings({ sourceId: pages.id });
    assert.deepEqual(published, []);
  });
});

describe("DiscoveryService.getListing", () => {
  test("gives a listing with its source, and null for an unknown one", async () => {
    const { service, pages, a } = await processedListings();
    assert.deepEqual(await service.getListing(a.id), {
      id: a.id,
      sourceId: pages.id,
      sourceName: "Organiser pages",
      url: null,
      state: "listed",
    });
    assert.equal(await service.getListing(randomUUID()), null);
  });
});
