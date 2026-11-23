import { isDatabaseUnavailable } from "@magic-events/core/adapters/storage/unavailable.ts";
import { createServices, type Overrides, type Services } from "@magic-events/core/services.ts";
import type { Settings } from "@magic-events/core/shared/settings.ts";
import type { Db } from "@magic-events/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type pino from "pino";
import { createServer } from "./rest/server.ts";

// Builds the server on the core's services. The domains, their adapters and the wiring between them are in
// packages/core; this app adds the inbound sides: REST, MCP and the scheduler.

export type { Overrides, Services };

export async function buildApp(deps: {
  settings: Settings;
  db: Db;
  logger: pino.Logger;
  overrides?: Overrides;
}): Promise<{ app: FastifyInstance; services: Services }> {
  const services = createServices(deps);
  const app = await createServer({
    settings: deps.settings.api,
    logger: deps.logger,
    services,
    checkDatabase: async () => {
      await deps.db.execute(sql`select 1`);
    },
    isUnavailable: isDatabaseUnavailable,
  });
  return { app, services };
}
