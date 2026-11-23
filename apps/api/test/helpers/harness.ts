import type { Db } from "@magic-events/db";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import type { Overrides, Services } from "@magic-events/core/services.ts";
import {
  createCaller,
  openTestDatabase,
  testOverrides,
  type CallerOptions,
  type TestCaller,
} from "@magic-events/core/testing/harness.ts";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.ts";

// The app against the test database, which is emptied first. Drive it with app.inject().

export interface Harness {
  app: FastifyInstance;
  db: Db;
  services: Services;
  // A tenant, a user in it and an API key for that user. Defaults: an active travel agency, the client role, a person's key.
  createCaller(options?: CallerOptions): Promise<TestCaller>;
  close(): Promise<void>;
}

// The overrides put a fake in place of the language model, the embedding model, the source adapters or the clock.
// The embedding model is always a fake, so no test reaches a cloud service.
export async function createHarness(overrides: Overrides = {}): Promise<Harness> {
  const database = await openTestDatabase();
  const { app, services } = await buildApp({
    settings: database.settings,
    db: database.db,
    logger: createLogger(database.settings.api),
    overrides: testOverrides(overrides),
  });
  await app.ready();

  return {
    app,
    db: database.db,
    services,
    createCaller: (options) => createCaller(services, options),
    async close() {
      await app.close();
      await database.close();
    },
  };
}
