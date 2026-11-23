import { createDb } from "@magic-events/db";
import { createJobQueue } from "./adapters/jobs/pg-boss.ts";
import { createLogger } from "./adapters/logging/pino.ts";
import { loadSettings } from "./adapters/settings/env.ts";
import { buildApp } from "./app.ts";
import type { Settings } from "./core/shared/settings.ts";
import { startJobs, type RunningJobs } from "./scheduler/jobs.ts";

// The entry point: settings, logger and database, then the server and, once it is listening, the jobs that fetch
// the sources that are due and process pending raw listings. Both stop cleanly on SIGINT and SIGTERM.

function settingsOrExit(): Settings {
  try {
    return loadSettings();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const settings = settingsOrExit();
const logger = createLogger(settings.api);
const database = createDb(settings.database.url);

try {
  const { app, services } = await buildApp({ settings, db: database.db, logger });
  // Empty until the server is listening, which is when the jobs start.
  const running: { jobs?: RunningJobs } = {};

  let stopping = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, "Stopping");
    try {
      // The jobs first, so the fetch or the raw listing in hand finishes before the database closes.
      await running.jobs?.stop();
      await app.close();
      await database.close();
      logger.info({}, "Stopped");
    } catch (error) {
      logger.error({ err: error }, "Could not stop cleanly");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", (signal) => void stop(signal));
  process.once("SIGTERM", (signal) => void stop(signal));

  await app.listen({ host: settings.api.host, port: settings.api.port });
  try {
    running.jobs = await startJobs({
      queue: createJobQueue({ databaseUrl: settings.database.url, logger }),
      catalogue: services.catalogue,
      discovery: services.discovery,
      dataProcessing: services.dataProcessing,
      discoverySettings: settings.discovery,
      processingSettings: settings.processing,
      catalogueSettings: settings.catalogue,
      logger,
    });
  } catch (error) {
    logger.fatal({ err: error }, "Could not start the jobs");
    process.exitCode = 1;
    await stop("the jobs could not start");
  }
} catch (error) {
  logger.fatal({ err: error }, "Could not start");
  await database.close();
  process.exitCode = 1;
}
