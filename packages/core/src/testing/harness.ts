import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@magic-events/db";
import { ensureDatabase, migrateDatabase } from "@magic-events/db/migrate";
import { sql } from "drizzle-orm";
import { createLogger } from "../adapters/logging/pino.ts";
import { loadSettings } from "../adapters/settings/env.ts";
import type { CallerKind } from "../identity/ports.ts";
import type { Role, TenantStatus } from "../organizations/ports.ts";
import { createServices, type Overrides, type Services } from "../services.ts";
import type { Settings } from "../shared/settings.ts";
import { FakeEmbeddingModel } from "./fake-embedding-model.ts";

// The services against the test database, which is emptied first. The API's own harness builds its server on this.

export interface TestCaller {
  key: string;
  userId: string;
  tenantId: string | null;
}

export interface CallerOptions {
  role?: Role;
  tenantStatus?: TenantStatus;
  kind?: CallerKind;
}

export interface Harness {
  db: Db;
  services: Services;
  // A tenant, a user in it and an API key for that user. Defaults: an active travel agency, the client role, a person's key.
  createCaller(options?: CallerOptions): Promise<TestCaller>;
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

// The test database, there, migrated and empty, with the settings that go with it.
export async function openTestDatabase(): Promise<{ db: Db; settings: Settings; close(): Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") throw new Error("Set TEST_DATABASE_URL to run the database tests.");
  await ensureDatabase(url);
  await migrateDatabase(url);

  const database = createDb(url, { max: 5 });
  await emptyEveryTable(database.db);
  return { db: database.db, settings: testSettings(url), close: () => database.close() };
}

// The embedding model is always a fake unless a test hands in its own, so no test reaches a cloud service.
export function testOverrides(overrides: Overrides): Overrides {
  return { embeddingModel: new FakeEmbeddingModel(), ...overrides };
}

export async function createCaller(services: Services, options: CallerOptions = {}): Promise<TestCaller> {
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
}

// The overrides put a fake in place of the language model, the embedding model, the source adapters or the clock.
export async function createHarness(overrides: Overrides = {}): Promise<Harness> {
  const database = await openTestDatabase();
  const services = createServices({
    settings: database.settings,
    db: database.db,
    logger: createLogger(database.settings.api),
    overrides: testOverrides(overrides),
  });

  return {
    db: database.db,
    services,
    createCaller: (options) => createCaller(services, options),
    close: () => database.close(),
  };
}
