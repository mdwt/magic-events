import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { apikey, user } from "@magic-events/db";
import { eq } from "drizzle-orm";
import { API_KEY_PREFIX } from "../src/adapters/auth/better-auth.ts";
import { CredentialRateLimitedError, type Identity } from "../src/core/identity/ports.ts";
import { UNAUTHENTICATED_MESSAGE } from "../src/core/identity/service.ts";
import { AppError } from "../src/core/shared/errors.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";

let harness: Harness;
let identity: Identity;

before(async () => {
  harness = await createHarness();
  identity = harness.services.identity;
});

after(() => harness.close());

// Every refused credential fails the same way, so a caller cannot tell why.
function unauthenticated(error: unknown): boolean {
  return error instanceof AppError && error.code === "unauthenticated" && error.message === UNAUTHENTICATED_MESSAGE;
}

function forbidden(error: unknown): boolean {
  return error instanceof AppError && error.code === "forbidden";
}

test("an issued key authenticates as its user, in their tenant, as a person", async () => {
  const { key, userId, tenantId } = await harness.createCaller();
  assert.ok(key.startsWith(API_KEY_PREFIX));

  const caller = await identity.authenticate(key);
  assert.equal(caller.userId, userId);
  assert.equal(caller.role, "client");
  assert.equal(caller.kind, "person");
  assert.ok(caller.tenant);
  assert.equal(caller.tenant.id, tenantId);
  assert.equal(caller.tenant.status, "active");
  assert.ok(caller.credentialId.length > 0);
  assert.ok(!caller.credentialId.includes(key));
});

test("an agent's key authenticates as an agent", async () => {
  const { key } = await harness.createCaller({ kind: "agent" });
  assert.equal((await identity.authenticate(key)).kind, "agent");
});

test("keys are stored hashed and listed without the key", async () => {
  const { key, userId } = await harness.createCaller();
  const agentKey = await identity.issueCredential({ userId, kind: "agent", name: "assistant" });

  const rows = await harness.db.select().from(apikey).where(eq(apikey.referenceId, userId));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.key, key);
    assert.notEqual(row.key, agentKey.key);
  }

  const listed = await identity.listCredentials(userId);
  assert.deepEqual(listed.map((one) => one.kind).sort(), ["agent", "person"]);
  assert.equal(listed.find((one) => one.kind === "agent")?.name, "assistant");
  assert.ok(listed.every((one) => one.enabled));
  assert.ok(!JSON.stringify(listed).includes(key));
  assert.ok(!JSON.stringify(listed).includes(agentKey.key));
});

test("a missing, empty, unknown, disabled or expired key is refused with one message", async () => {
  await assert.rejects(identity.authenticate(undefined), unauthenticated);
  await assert.rejects(identity.authenticate(""), unauthenticated);
  await assert.rejects(identity.authenticate(`${API_KEY_PREFIX}not-a-real-key`), unauthenticated);

  const disabled = await harness.createCaller();
  await harness.db.update(apikey).set({ enabled: false }).where(eq(apikey.referenceId, disabled.userId));
  await assert.rejects(identity.authenticate(disabled.key), unauthenticated);

  const expired = await harness.createCaller();
  await harness.db
    .update(apikey)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(apikey.referenceId, expired.userId));
  await assert.rejects(identity.authenticate(expired.key), unauthenticated);
});

test("a key whose user no longer exists is refused", async () => {
  const { key, userId } = await harness.createCaller({ role: "system_admin" });
  await harness.db.delete(user).where(eq(user.id, userId));
  await assert.rejects(identity.authenticate(key), unauthenticated);
});

test("a key over its rate limit is refused with rate_limited and when to try again", async () => {
  const { key, userId } = await harness.createCaller();
  await harness.db.update(apikey).set({ rateLimitMax: 2 }).where(eq(apikey.referenceId, userId));

  await identity.authenticate(key);
  await identity.authenticate(key);
  await assert.rejects(
    identity.authenticate(key),
    (error: unknown) =>
      error instanceof CredentialRateLimitedError &&
      error.code === "rate_limited" &&
      error.retryAfterSeconds !== undefined &&
      error.retryAfterSeconds > 0,
  );
});

test("a client in an active tenant may act, and a client in a suspended tenant may not", async () => {
  const active = await identity.authenticate((await harness.createCaller()).key);
  identity.authorise(active, "experiences.search");
  identity.authorise(active, "mcp.use");

  const suspended = await identity.authenticate((await harness.createCaller({ tenantStatus: "suspended" })).key);
  assert.equal(suspended.tenant?.status, "suspended");
  assert.throws(() => {
    identity.authorise(suspended, "experiences.search");
  }, forbidden);
  assert.throws(() => {
    identity.authorise(suspended, "openapi.read");
  }, forbidden);
});

test("a system admin belongs to no tenant and may do everything", async () => {
  const admin = await identity.authenticate((await harness.createCaller({ role: "system_admin" })).key);
  assert.equal(admin.tenant, null);
  for (const action of ["experiences.search", "mcp.use", "openapi.read"] as const) {
    identity.authorise(admin, action);
  }
});

test("a credential is issued only for a user that exists, with a usable name", async () => {
  await assert.rejects(
    identity.issueCredential({ userId: "no-such-user", kind: "person", name: "key" }),
    (error: unknown) => error instanceof AppError && error.code === "not_found",
  );
  const { userId } = await harness.createCaller();
  await assert.rejects(
    identity.issueCredential({ userId, kind: "person", name: "x".repeat(33) }),
    (error: unknown) => error instanceof AppError && error.code === "invalid_input",
  );
});
