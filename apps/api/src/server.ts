import { createDb } from "@magic-events/db";
import { createLogger } from "./adapters/logging/pino.ts";
import { loadSettings } from "./adapters/settings/env.ts";
import { buildApp } from "./app.ts";
import type { Settings } from "./core/shared/settings.ts";
import { startSchedule, type Schedule } from "./scheduler/schedule.ts";

// The entry point: settings, logger and database, then the server and, inside it, the schedule that fetches the
// sources that are due and processes pending raw listings. Both stop cleanly on SIGINT and SIGTERM.

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
  let schedule: Schedule | undefined;

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Stopping");
    try {
      // The schedule first, so the fetch or the raw listing in hand finishes before the database closes.
      await schedule?.stop();
      await app.close();
      await database.close();
      logger.info("Stopped");
    } catch (error) {
      logger.error({ err: error }, "Could not stop cleanly");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", (signal) => void stop(signal));
  process.once("SIGTERM", (signal) => void stop(signal));

  await app.listen({ host: settings.api.host, port: settings.api.port });
  schedule = startSchedule({
    discovery: services.discovery,
    dataProcessing: services.dataProcessing,
    discoverySettings: settings.discovery,
    processingSettings: settings.processing,
    logger,
  });
} catch (error) {
  logger.fatal({ err: error }, "Could not start");
  await database.close();
  process.exitCode = 1;
}
