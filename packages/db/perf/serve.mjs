/* global process */

// The API on a measurement database, with no jobs: the same app as apps/api/src/server.ts, minus the scheduler, so
// nothing fetches a source or calls a model while requests are timed.
//
//   DATABASE_URL=postgres://magic:magic@localhost:5434/magic_events_perf API_PORT=4100 LOG_LEVEL=debug \
//     node --env-file-if-exists=.env packages/db/perf/serve.mjs
//
// Every request's "Request completed" line carries its durationMs.

import { createDb } from "../src/index.ts";
import { createLogger } from "../../core/src/adapters/logging/pino.ts";
import { loadSettings } from "../../core/src/adapters/settings/env.ts";
import { buildApp } from "../../../apps/api/src/app.ts";

const settings = loadSettings();
if (!/magic_events_perf/.test(settings.database.url)) {
  throw new Error("serve.mjs runs only on a magic_events_perf database.");
}
const logger = createLogger(settings.api);
const database = createDb(settings.database.url);
const { app } = await buildApp({ settings, db: database.db, logger });

const stop = async () => {
  await app.close();
  await database.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await app.listen({ host: settings.api.host, port: settings.api.port });
