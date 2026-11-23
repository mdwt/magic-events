import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tenant, user } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { Organizations } from "../src/organizations/ports.ts";
import { AppError } from "../src/shared/errors.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

let harness: Harness;
let organizations: Organizations;

before(async () => {
  harness = await createHarness();
  organizations = harness.services.organizations;
});

after(() => harness.close());

function failsWith(code: AppError["code"]) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

test("a tenant is created, then updated by its slug", async () => {
  const created = await organizations.saveTenant({ name: "Blue Agency", slug: "blue", kind: "travel_agency" });
  assert.equal(created.status, "active");
  assert.deepEqual(created.configuration, {});

  const updated = await organizations.saveTenant({
    name: "Blue Travel",
    slug: "blue",
    kind: "travel_app",
    status: "suspended",
    configuration: { region: "Western Cape" },
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, "Blue Travel");
  assert.equal(updated.kind, "travel_app");
  assert.equal(updated.status, "suspended");
  assert.deepEqual(updated.configuration, { region: "Western Cape" });

  const rows = await harness.db.select().from(tenant).where(eq(tenant.slug, "blue"));
  assert.equal(rows.length, 1);
  assert.deepEqual(await organizations.getTenant(created.id), updated);
});

test("a tenant that does not exist is null, also for an ID that is not a UUID", async () => {
  assert.equal(await organizations.getTenant("00000000-0000-4000-8000-000000000000"), null);
  assert.equal(await organizations.getTenant("not-a-uuid"), null);
});

test("a client is created in their tenant, then updated by email, which is stored lower-cased", async () => {
  const agency = await organizations.saveTenant({ name: "Green Agency", slug: "green", kind: "travel_agency" });
  const created = await organizations.saveUser({
    name: "Ann",
    email: "  Ann@Green.Example.COM ",
    role: "client",
    tenantSlug: "green",
  });
  assert.equal(created.email, "ann@green.example.com");
  assert.equal(created.tenantId, agency.id);
  assert.equal(created.role, "client");

  const updated = await organizations.saveUser({
    name: "Ann Smith",
    email: "ann@green.example.com",
    role: "client",
    tenantSlug: "green",
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, "Ann Smith");
  assert.equal((await harness.db.select().from(user).where(eq(user.email, "ann@green.example.com"))).length, 1);

  const membership = await organizations.getMembership(created.id);
  assert.deepEqual(membership, { user: updated, tenant: agency });
});

test("a system admin belongs to no tenant", async () => {
  const admin = await organizations.saveUser({ name: "Root", email: "root@example.com", role: "system_admin" });
  assert.equal(admin.tenantId, null);
  assert.deepEqual(await organizations.getMembership(admin.id), { user: admin, tenant: null });

  await assert.rejects(
    organizations.saveUser({ name: "Root", email: "root@example.com", role: "system_admin", tenantSlug: "green" }),
    failsWith("invalid_input"),
  );
});

test("a client must have a tenant, and the tenant must exist", async () => {
  await assert.rejects(
    organizations.saveUser({ name: "Bob", email: "bob@example.com", role: "client" }),
    failsWith("invalid_input"),
  );
  await assert.rejects(
    organizations.saveUser({ name: "Bob", email: "bob@example.com", role: "client", tenantSlug: "nowhere" }),
    failsWith("not_found"),
  );
});

test("a user that does not exist has no membership", async () => {
  assert.equal(await organizations.getMembership("no-such-user"), null);
});

test("a taken slug and a taken email address are refused with conflict, however the address is written", async () => {
  await organizations.createTenant({ name: "Red Agency", slug: "red", kind: "travel_agency" });
  await assert.rejects(
    organizations.createTenant({ name: "Red Again", slug: "red", kind: "travel_app" }),
    failsWith("conflict"),
  );
  assert.equal((await harness.db.select().from(tenant).where(eq(tenant.slug, "red"))).length, 1);

  await organizations.createUser({ name: "Rae", email: "rae@red.example.com", role: "client", tenantSlug: "red" });
  await assert.rejects(
    organizations.createUser({ name: "Rae again", email: "RAE@red.example.com", role: "client", tenantSlug: "red" }),
    failsWith("conflict"),
  );
  assert.equal((await harness.db.select().from(user).where(eq(user.email, "rae@red.example.com"))).length, 1);
});

test("a user is found by their email address, however it is written, and an unknown one is not_found", async () => {
  await organizations.saveTenant({ name: "Teal Agency", slug: "teal", kind: "travel_agency" });
  const created = await organizations.createUser({
    name: "Tom",
    email: "tom@teal.example.com",
    role: "client",
    tenantSlug: "teal",
  });
  assert.deepEqual(await organizations.getUserByEmail(" Tom@Teal.example.COM "), created);
  await assert.rejects(organizations.getUserByEmail("nobody@teal.example.com"), failsWith("not_found"));
});
