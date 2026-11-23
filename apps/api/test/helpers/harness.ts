import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@magic-events/db";
import { ensureDatabase, migrateDatabase } from "@magic-events/db/migrate";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createLogger } from "../../src/adapters/logging/pino.ts";
import { loadSettings } from "../../src/adapters/settings/env.ts";
import { buildApp, type Overrides, type Services } from "../../src/app.ts";
import type { CallerKind } from "../../src/core/identity/ports.ts";
import type { Role, TenantStatus } from "../../src/core/organizations/ports.ts";
import type { Settings } from "../../src/core/shared/settings.ts";

// The app against the test database, which is emptied first. Drive it with app.inject().

export interface Harness {
  app: FastifyInstance;
  db: Db;
  services: Services;
  // A tenant, a user in it and an API key for that user. Defaults: an active travel agency, the client role, a person's key.
  createCaller(options?: {
    role?: Role;
    tenantStatus?: TenantStatus;
    kind?: CallerKind;
  }): Promise<{ key: string; userId: string; tenantId: string | null }>;
  close(): Promise<void>;
}

// The test settings: the environment's, on the test database, silent unless LOG_LEVEL is set.
export function testSettings(databaseUrl: string): Settings {
  return loadSettings({
    ...process.env,
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "test-secret-that-is-at-least-32-characters",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
    LOG_PRETTY: "false",
  });
}

async function emptyEveryTable(db: Db): Promise<void> {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  if (tables.length === 0) return;
  const names = sql.join(
    tables.map((table) => sql.identifier(table.tablename)),
    sql`, `,
  );
  await db.execute(sql`truncate table ${names} restart identity cascade`);
}

// The overrides put a fake in place of the language model, the source adapters or the clock.
export async function createHarness(overrides: Overrides = {}): Promise<Harness> {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") throw new Error("Set TEST_DATABASE_URL to run the database tests.");
  await ensureDatabase(url);
  await migrateDatabase(url);

  const database = createDb(url, { max: 5 });
  await emptyEveryTable(database.db);

  const settings = testSettings(url);
  const { app, services } = await buildApp({
    settings,
    db: database.db,
    logger: createLogger(settings.api),
    overrides,
  });
  await app.ready();

  return {
    app,
    db: database.db,
    services,

    async createCaller(options = {}) {
      const unique = randomUUID().slice(0, 8);
      const role = options.role ?? "client";
      let tenantSlug: string | undefined;
      if (role === "client") {
        const tenant = await services.organizations.saveTenant({
          name: `Test agency ${unique}`,
          slug: `test-agency-${unique}`,
          kind: "travel_agency",
          status: options.tenantStatus ?? "active",
        });
        tenantSlug = tenant.slug;
      }
      const user = await services.organizations.saveUser({
        name: `Test user ${unique}`,
        email: `user-${unique}@test.example.com`,
        role,
        ...(tenantSlug === undefined ? {} : { tenantSlug }),
      });
      const credential = await services.identity.issueCredential({
        userId: user.id,
        kind: options.kind ?? "person",
        name: `test key ${unique}`,
      });
      return { key: credential.key, userId: user.id, tenantId: user.tenantId };
    },

    async close() {
      await app.close();
      await database.close();
    },
  };
}
