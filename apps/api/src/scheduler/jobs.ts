import type { Catalogue } from "../core/catalogue/ports.ts";
import type { DataProcessing } from "../core/data-processing/ports.ts";
import type { Discovery } from "../core/discovery/ports.ts";
import type { JobQueue } from "../core/shared/jobs.ts";
import type { Logger } from "../core/shared/logger.ts";
import type { CatalogueSettings, DiscoverySettings, ProcessingSettings } from "../core/shared/settings.ts";
import {
  DRAIN_KEY,
  EMBED_KEY,
  embedExperiences,
  fetchSource,
  findDueSources,
  keepUp,
  processPending,
} from "./handlers.ts";

// The scheduler: the inbound side that no client is behind. Its handlers call the core through its ports, like
// REST and MCP do, and run as jobs on the job queue, which keeps them, schedules them and tries a failed one again.

// Every hour, pending raw listings are processed even if no fetch asked for it, so none is ever stranded.
export const DRAIN_SAFETY_NET_CRON = "0 * * * *";
// Every 15 minutes, experiences are embedded even if no drain asked for it, so a round the model failed on, or a
// change of embedding model, is caught up.
export const EMBED_SAFETY_NET_CRON = "*/15 * * * *";

export interface RunningJobs {
  // Stops taking jobs and lets the ones in hand finish.
  stop(): Promise<void>;
}

export async function startJobs(deps: {
  queue: JobQueue;
  catalogue: Catalogue;
  discovery: Discovery;
  dataProcessing: DataProcessing;
  discoverySettings: DiscoverySettings;
  processingSettings: ProcessingSettings;
  catalogueSettings: CatalogueSettings;
  logger: Logger;
}): Promise<RunningJobs> {
  const logger = deps.logger.child({ component: "jobs" });
  const handlerDeps = { ...deps, logger };
  deps.queue.register(findDueSources(handlerDeps));
  deps.queue.register(fetchSource(handlerDeps));
  deps.queue.register(processPending(handlerDeps));
  deps.queue.register(embedExperiences(handlerDeps));
  deps.queue.register(keepUp(handlerDeps));
  await deps.queue.start();

  try {
    await deps.queue.schedule("discovery.find-due-sources", deps.discoverySettings.scheduleCron, {});
    await deps.queue.schedule("processing.process-pending", DRAIN_SAFETY_NET_CRON, {}, { key: DRAIN_KEY });
    await deps.queue.schedule("catalogue.embed-experiences", EMBED_SAFETY_NET_CRON, {}, { key: EMBED_KEY });
    await deps.queue.schedule("catalogue.keep-up", deps.catalogueSettings.upkeepCron, {});
  } catch (error) {
    await deps.queue.stop();
    throw error;
  }
  logger.info(
    {
      findDueSourcesCron: deps.discoverySettings.scheduleCron,
      drainCron: DRAIN_SAFETY_NET_CRON,
      embedCron: EMBED_SAFETY_NET_CRON,
      upkeepCron: deps.catalogueSettings.upkeepCron,
      workers: deps.processingSettings.workers,
    },
    "The jobs started",
  );

  return {
    async stop() {
      await deps.queue.stop();
      logger.info({}, "The jobs stopped");
    },
  };
}
