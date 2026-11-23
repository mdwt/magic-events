import type { DataProcessing } from "../core/data-processing/ports.ts";
import type { Discovery } from "../core/discovery/ports.ts";
import type { Logger } from "../core/shared/logger.ts";
import type { DiscoverySettings, ProcessingSettings } from "../core/shared/settings.ts";

// The scheduler: the inbound side that no client is behind. It starts discovery for the sources that are due
// and keeps the processing workers going. It calls the core through its ports, like REST and MCP do.

export interface Schedule {
  // Lets the fetch or the raw listing in hand finish, then stops.
  stop(): Promise<void>;
}

export function startSchedule(deps: {
  discovery: Discovery;
  dataProcessing: DataProcessing;
  discoverySettings: DiscoverySettings;
  processingSettings: ProcessingSettings;
  logger: Logger;
}): Schedule {
  const logger = deps.logger.child({ component: "scheduler" });
  const stopping = new AbortController();

  // Resolves after the wait, or at once when the schedule is stopping.
  const wait = (seconds: number) =>
    new Promise<void>((resolve) => {
      if (stopping.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, seconds * 1000);
      function done() {
        clearTimeout(timer);
        stopping.signal.removeEventListener("abort", done);
        resolve();
      }
      stopping.signal.addEventListener("abort", done);
    });

  // One round after another, never two at once. A round that throws is logged and the loop goes on.
  async function loop(name: string, intervalSeconds: number, round: () => Promise<boolean>): Promise<void> {
    while (!stopping.signal.aborted) {
      let more = false;
      try {
        more = await round();
      } catch (error) {
        logger.error({ err: error, loop: name }, "A scheduled round failed");
      }
      if (!more) await wait(intervalSeconds);
    }
  }

  const discovery = loop("discovery", deps.discoverySettings.scheduleIntervalSeconds, async () => {
    const runs = await deps.discovery.runDueSources();
    if (runs.length > 0) {
      logger.info(
        { runs: runs.length, failed: runs.filter((run) => run.status === "failed").length },
        "Fetched the sources that were due",
      );
    }
    return false;
  });

  // A worker goes straight on to the next raw listing while there is one, and waits the idle interval when there is none.
  const workers = Array.from({ length: deps.processingSettings.workers }, (_, index) =>
    loop(`processing-${index + 1}`, deps.processingSettings.idleIntervalSeconds, async () => {
      const outcome = await deps.dataProcessing.processNext();
      return outcome !== null;
    }),
  );

  logger.info(
    {
      scheduleIntervalSeconds: deps.discoverySettings.scheduleIntervalSeconds,
      workers: deps.processingSettings.workers,
      idleIntervalSeconds: deps.processingSettings.idleIntervalSeconds,
    },
    "The schedule started",
  );

  return {
    async stop() {
      stopping.abort();
      await Promise.all([discovery, ...workers]);
      logger.info({}, "The schedule stopped");
    },
  };
}
