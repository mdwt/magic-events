import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createDb } from "@magic-events/db";
import { createAuth } from "../src/adapters/auth/better-auth.ts";
import type { Action, Caller } from "../src/core/identity/ports.ts";
import { IdentityService } from "../src/core/identity/service.ts";
import type { Membership } from "../src/core/organizations/ports.ts";
import { AppError } from "../src/core/shared/errors.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import { testSettings } from "./helpers/harness.ts";

// The authorisation table, with no database: authorise reads only the caller, and nothing here connects.

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

const url = "postgres://nobody@localhost:1/none";
const database = createDb(url, { max: 1 });
after(() => database.close());

const settings = testSettings(url).identity;
const identity = new IdentityService({
  auth: createAuth(database.db, settings),
  organizations: {
    saveTenant: () => Promise.reject(new Error("not used")),
    getTenant: () => Promise.resolve(null),
    saveUser: () => Promise.reject(new Error("not used")),
    getMembership: (): Promise<Membership | null> => Promise.resolve(null),
  },
  settings,
  logger: silent,
});

const ACTIONS: Action[] = ["experiences.search", "mcp.use", "health.read", "openapi.read"];

function caller(overrides: Partial<Caller>): Caller {
  return {
    userId: "u1",
    role: "client",
    kind: "person",
    credentialId: "c1",
    tenant: { id: "t1", slug: "agency", status: "active" },
    ...overrides,
  };
}

function forbidden(error: unknown): boolean {
  return error instanceof AppError && error.code === "forbidden";
}

test("a client in an active tenant may do every action, as a person or an agent", () => {
  for (const kind of ["person", "agent"] as const) {
    for (const action of ACTIONS) identity.authorise(caller({ kind }), action);
  }
});

test("a client in a suspended tenant may do nothing", () => {
  const suspended = caller({ tenant: { id: "t1", slug: "agency", status: "suspended" } });
  for (const action of ACTIONS) {
    assert.throws(() => {
      identity.authorise(suspended, action);
    }, forbidden);
  }
});

test("a client without a tenant may do nothing", () => {
  for (const action of ACTIONS) {
    assert.throws(() => {
      identity.authorise(caller({ tenant: null }), action);
    }, forbidden);
  }
});

test("a system admin may do everything", () => {
  for (const action of ACTIONS) identity.authorise(caller({ role: "system_admin", tenant: null }), action);
});

test("a missing credential is refused before Better Auth is asked", async () => {
  await assert.rejects(
    identity.authenticate(undefined),
    (error: unknown) => error instanceof AppError && error.code === "unauthenticated",
  );
});
