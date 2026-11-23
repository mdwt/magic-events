import type { Catalogue } from "../core/catalogue/ports.ts";
import type { DataProcessing, ProcessingOutcome } from "../core/data-processing/ports.ts";
import type { Discovery } from "../core/discovery/ports.ts";
import type { JobHandler, JobQueue } from "../core/shared/jobs.ts";
import type { Logger } from "../core/shared/logger.ts";
import type { DiscoverySettings, ProcessingSettings } from "../core/shared/settings.ts";

// What each job does. Every handler is safe to run on several servers at once: Discovery refuses a second fetch
// of a source with a run in progress, and a raw listing is claimed by one worker only.

// The one key every drain is queued under, so only one waits at a time.
export const DRAIN_KEY = "pending";
// The one key every embedding job is queued under, so only one waits at a time.
export const EMBED_KEY = "embeddings";

const MINUTE = 60;
// Sources fetched side by side by one server. Each is a different site.
const FETCH_CONCURRENCY = 2;

interface Deps {
  queue: JobQueue;
  catalogue: Catalogue;
  discovery: Discovery;
  dataProcessing: DataProcessing;
  discoverySettings: DiscoverySettings;
  processingSettings: ProcessingSettings;
  logger: Logger;
}

// Queues a fetch of each source that is due. A tick that fails is not worth many retries: the next one does the
// same work.
export function findDueSources(deps: Deps): JobHandler<"discovery.find-due-sources"> {
  return {
    name: "discovery.find-due-sources",
    policy: { retries: 2, retryDelaySeconds: MINUTE, retryBackoff: false, timeoutSeconds: 5 * MINUTE, concurrency: 1 },
    async run() {
      const sources = await deps.discovery.findDueSources();
      // Keyed by the source, so a source whose fetch is still waiting is not queued again.
      for (const source of sources) {
        await deps.queue.enqueue("discovery.fetch-source", { sourceId: source.id }, { key: source.id });
      }
      if (sources.length > 0) {
        deps.logger.info({ sources: sources.length }, "Queued a fetch of each source that is due");
      }
    },
  };
}

// Fetches one source. A failed run fails the job, so the queue tries it again with a doubling wait. When the
// retries are used up the source is due again one fetch interval after its last run started.
export function fetchSource(deps: Deps): JobHandler<"discovery.fetch-source"> {
  const settings = deps.discoverySettings;
  return {
    name: "discovery.fetch-source",
    policy: {
      retries: settings.fetchRetries,
      retryDelaySeconds: settings.fetchRetryBackoffMinutes * MINUTE,
      retryBackoff: true,
      timeoutSeconds: settings.runTimeoutMinutes * MINUTE,
      concurrency: FETCH_CONCURRENCY,
    },
    async run({ sourceId }) {
      const run = await deps.discovery.runSource(sourceId);
      if (run.status === "failed") {
        throw new Error(`The fetch of ${run.sourceName} failed: ${run.error ?? "no error was given"}`);
      }
      deps.logger.info(
        {
          sourceId,
          source: run.sourceName,
          runId: run.runId,
          complete: run.complete,
          found: run.listingsFound,
          newOrChanged: run.listingsNewOrChanged,
          unchanged: run.listingsUnchanged,
          removed: run.listingsRemoved,
        },
        "Fetched a source",
      );
      if (run.listingsNewOrChanged + run.listingsRemoved > 0) {
        await deps.queue.enqueue("processing.process-pending", {}, { key: DRAIN_KEY });
      }
    },
  };
}

// Processes pending raw listings until none is left, with the configured number of workers side by side. A raw
// listing that fails goes back to pending for another attempt, so the drain stops and fails, and the queue runs it
// again after a wait instead of retrying that raw listing straight away.
export function processPending(deps: Deps): JobHandler<"processing.process-pending"> {
  return {
    name: "processing.process-pending",
    // The language model can take minutes over one raw listing, so a drain can take an hour.
    policy: { retries: 5, retryDelaySeconds: MINUTE, retryBackoff: true, timeoutSeconds: 120 * MINUTE, concurrency: 1 },
    async run(_payload, job) {
      const halt = new AbortController();
      const signal = AbortSignal.any([job.signal, halt.signal]);
      let processed = 0;
      const failed: ProcessingOutcome[] = [];
      const errors: unknown[] = [];

      // Resolves true when nothing was pending, false when it stopped first.
      async function worker(): Promise<boolean> {
        while (!signal.aborted) {
          let outcome: ProcessingOutcome | null;
          try {
            outcome = await deps.dataProcessing.processNext();
          } catch (error) {
            errors.push(error);
            halt.abort();
            return false;
          }
          if (outcome === null) return true;
          if (outcome.outcome === "failed") {
            failed.push(outcome);
            halt.abort();
            return false;
          }
          processed += 1;
        }
        return false;
      }

      const workers = await Promise.all(Array.from({ length: deps.processingSettings.workers }, worker));
      const drained = workers.every(Boolean);
      // The hourly safety net mostly finds nothing, which is not worth an info line.
      const level = processed + failed.length > 0 ? "info" : "debug";
      deps.logger[level]({ processed, failed: failed.length, drained }, "Processed pending raw listings");
      // What was saved may have a new title or profile, which clears its embedding.
      if (processed > 0) {
        await deps.queue.enqueue("catalogue.embed-experiences", {}, { key: EMBED_KEY });
      }

      if (errors.length > 0) throw errors[0];
      const [first] = failed;
      if (first) {
        throw new Error(`Raw listing ${first.rawListingId} from ${first.sourceName} failed: ${first.error ?? "no error was given"}`);
      }
      if (!drained) throw new Error("The drain stopped before every pending raw listing was processed.");
    },
  };
}

// Embeds, round after round, the experiences that have no embedding from the current model, until none is left.
// A round in which the model failed on every text fails the job, so the queue tries it again after a doubling wait.
// A text the model fails on in a round where others succeed is taken again in a later round.
export function embedExperiences(deps: Deps): JobHandler<"catalogue.embed-experiences"> {
  return {
    name: "catalogue.embed-experiences",
    // A text takes the model well under a second, so a round of a hundred takes seconds.
    policy: { retries: 5, retryDelaySeconds: MINUTE, retryBackoff: true, timeoutSeconds: 30 * MINUTE, concurrency: 1 },
    async run(_payload, job) {
      let embedded = 0;
      let rounds = 0;
      let last = { embedded: 0, failed: 0, remaining: 0 };
      while (!job.signal.aborted) {
        last = await deps.catalogue.embedExperiences();
        rounds += 1;
        embedded += last.embedded;
        if (last.remaining === 0 || (last.embedded === 0 && last.failed > 0)) break;
      }
      const { failed, remaining } = last;
      // The safety net mostly finds nothing, which is not worth an info line.
      const level = embedded + failed > 0 ? "info" : "debug";
      deps.logger[level]({ rounds, embedded, failed, remaining }, "Embedded experiences");

      if (last.embedded === 0 && failed > 0) {
        throw new Error(`The embedding model failed on all ${String(failed)} experiences of a round.`);
      }
      if (remaining > 0) throw new Error("The embedding stopped before every experience was embedded.");
    },
  };
}

// Catalogue's upkeep: finished experiences to Past, bookings past their close time to Closed, and the sessions of
// open-ended recurring experiences generated further ahead. An experience that fails is logged and left for the next
// run. A run that fails is not worth many retries: the next one does the same work.
export function keepUp(deps: Deps): JobHandler<"catalogue.keep-up"> {
  return {
    name: "catalogue.keep-up",
    policy: { retries: 2, retryDelaySeconds: MINUTE, retryBackoff: false, timeoutSeconds: 30 * MINUTE, concurrency: 1 },
    async run() {
      const result = await deps.catalogue.keepUp();
      // Most runs find nothing to do, which is not worth an info line.
      const level = result.past + result.bookingsClosed + result.sessionsGenerated > 0 ? "info" : "debug";
      deps.logger[level]({ ...result }, "Kept the catalogue up");
    },
  };
}
