import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createDb } from "@magic-events/db";
import type { DBAdapter } from "better-auth";
import { createAuth } from "../src/adapters/auth/better-auth.ts";
import { IdentityService } from "../src/core/identity/service.ts";
import type { Membership, Organizations } from "../src/core/organizations/ports.ts";
import { AppError } from "../src/core/shared/errors.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import { testSettings } from "./helpers/harness.ts";

// The credential rules of Identity, with no database: Organizations is a fake, and the keys Better Auth holds are a
// fake adapter. Nothing here reaches Better Auth's endpoints, which would connect.

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

const ANN = "user-ann";
const BOB = "user-bob";

function member(id: string): Membership {
  return { user: { id, name: id, email: `${id}@example.com`, role: "client", tenantId: "t1" }, tenant: null };
}

const organizations: Organizations = {
  saveTenant: () => Promise.reject(new Error("not used")),
  createTenant: () => Promise.reject(new Error("not used")),
  updateTenant: () => Promise.reject(new Error("not used")),
  listTenants: () => Promise.resolve([]),
  getTenant: () => Promise.resolve(null),
  getTenantBySlug: () => Promise.reject(new Error("not used")),
  listUsers: () => Promise.resolve([]),
  saveUser: () => Promise.reject(new Error("not used")),
  createUser: () => Promise.reject(new Error("not used")),
  getMembership: (userId) => Promise.resolve([ANN, BOB].includes(userId) ? member(userId) : null),
};

// Bob's one key, as Better Auth's adapter returns it for a lookup by user.
const KEYS = [{ id: "key-bob", name: "desk", enabled: true, metadata: '{"kind":"person"}', referenceId: BOB }];

const findMany: DBAdapter["findMany"] = ({ where }) => {
  const userId = where?.find((clause) => clause.field === "referenceId")?.value;
  // The adapter's result is typed by the caller; these rows have the fields Identity selects.
  return Promise.resolve(KEYS.filter((key) => key.referenceId === userId) as never[]);
};

// Whether the key store answers the check Identity makes before it trusts an "invalid key" verdict.
let storeAnswers = true;
const findOne: DBAdapter["findOne"] = () =>
  storeAnswers ? Promise.resolve(null) : Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1"));

const settings = testSettings(url).identity;
const { api } = createAuth(database.db, settings);
const identity = new IdentityService({
  auth: { api, $context: Promise.resolve({ adapter: { findMany, findOne } }) },
  organizations,
  settings,
  logger: silent,
});

function failsWith(code: AppError["code"]) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

test("the credentials of a user that does not exist are not_found", async () => {
  await assert.rejects(identity.listCredentials("no-such-user"), failsWith("not_found"));
  await assert.rejects(identity.revokeCredential("no-such-user", "key-bob"), failsWith("not_found"));
  await assert.rejects(
    identity.issueCredential({ userId: "no-such-user", kind: "person", name: "desk" }),
    failsWith("not_found"),
  );
});

test("a credential of another user is not_found, so it cannot be revoked through the wrong user", async () => {
  assert.deepEqual(await identity.listCredentials(ANN), []);
  await assert.rejects(identity.revokeCredential(ANN, "key-bob"), failsWith("not_found"));
});

test("a credential ID the user does not have is not_found", async () => {
  await assert.rejects(identity.revokeCredential(BOB, "no-such-key"), failsWith("not_found"));
});

test("a credential's name must be 1 to 32 characters once trimmed", async () => {
  for (const name of ["", "   ", "x".repeat(33)]) {
    await assert.rejects(identity.issueCredential({ userId: ANN, kind: "person", name }), failsWith("invalid_input"));
  }
});

// Better Auth's key check runs against a database that refuses connections, so its every lookup fails. The plugin
// catches that and answers that the key is invalid, which must not reach a caller as 401.
test("a key check that cannot reach the database is unavailable, never unauthenticated", async () => {
  storeAnswers = false;
  try {
    await assert.rejects(identity.authenticate("mev_a-good-key"), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "unavailable");
      assert.ok(error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0);
      assert.match((error.cause as Error).message, /ECONNREFUSED/);
      return true;
    });
  } finally {
    storeAnswers = true;
  }
});

test("a key check that failed inside Better Auth is a system error, even when the key store answers", async () => {
  await assert.rejects(
    identity.authenticate("mev_a-good-key"),
    (error: unknown) => error instanceof Error && !(error instanceof AppError),
  );
});
