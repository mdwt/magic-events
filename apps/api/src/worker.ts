import { createDb } from "@magic-events/db";
import { createLogger } from "./adapters/logging/pino.ts";
import { loadSettings } from "./adapters/settings/env.ts";
import { createServices } from "./app.ts";
import type { Settings } from "./core/shared/settings.ts";
import { startSchedule } from "./scheduler/schedule.ts";

// The worker's entry point: the schedule that fetches the sources that are due and processes pending raw listings.
// It runs beside the API server and shares nothing with it but the database. It stops cleanly on SIGINT and SIGTERM.

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
// One connection for the schedule's own queries and one for each worker's transaction, with room to spare.
const database = createDb(settings.database.url, { max: settings.processing.workers + 4 });

const services = createServices({ settings, db: database.db, logger });
const schedule = startSchedule({
  discovery: services.discovery,
  dataProcessing: services.dataProcessing,
  discoverySettings: settings.discovery,
  processingSettings: settings.processing,
  logger,
});

let stopping = false;
const stop = async (signal: NodeJS.Signals): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Stopping the worker");
  try {
    await schedule.stop();
    await database.close();
    logger.info("The worker stopped");
  } catch (error) {
    logger.error({ err: error }, "The worker could not stop cleanly");
    process.exitCode = 1;
  }
};
process.once("SIGINT", (signal) => void stop(signal));
process.once("SIGTERM", (signal) => void stop(signal));
