import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import type { Membership, OrganizationsRepository, Tenant, User } from "../src/organizations/ports.ts";
import { OrganizationsService } from "../src/organizations/service.ts";
import { AppError } from "../src/shared/errors.ts";
import type { Logger } from "../src/shared/logger.ts";

// The onboarding rules of Organizations, on a repository kept in memory.

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

function memoryRepository(): OrganizationsRepository {
  const tenants: Tenant[] = [];
  const users: User[] = [];
  const bySlug = (slug: string) => tenants.find((one) => one.slug === slug) ?? null;
  return {
    upsertTenant(input) {
      const existing = bySlug(input.slug);
      if (existing) return Promise.resolve(Object.assign(existing, input));
      const created = { id: randomUUID(), ...input };
      tenants.push(created);
      return Promise.resolve(created);
    },
    insertTenant(input) {
      if (bySlug(input.slug)) return Promise.resolve(null);
      const created = { id: randomUUID(), ...input };
      tenants.push(created);
      return Promise.resolve(created);
    },
    updateTenant(slug, changes) {
      const existing = bySlug(slug);
      return Promise.resolve(existing ? Object.assign(existing, changes) : null);
    },
    listTenants: () => Promise.resolve([...tenants].sort((a, b) => a.name.localeCompare(b.name))),
    findTenantById: (id) => Promise.resolve(tenants.find((one) => one.id === id) ?? null),
    findTenantBySlug: (slug) => Promise.resolve(bySlug(slug)),
    listUsers: (tenantId) => Promise.resolve(users.filter((one) => one.tenantId === tenantId)),
    upsertUser(input) {
      const existing = users.find((one) => one.email === input.email);
      if (existing) return Promise.resolve(Object.assign(existing, input));
      const created = { id: randomUUID(), ...input };
      users.push(created);
      return Promise.resolve(created);
    },
    insertUser(input) {
      if (users.some((one) => one.email === input.email)) return Promise.resolve(null);
      const created = { id: randomUUID(), ...input };
      users.push(created);
      return Promise.resolve(created);
    },
    findMembership(userId): Promise<Membership | null> {
      const user = users.find((one) => one.id === userId);
      if (!user) return Promise.resolve(null);
      return Promise.resolve({ user, tenant: tenants.find((one) => one.id === user.tenantId) ?? null });
    },
  };
}

let organizations: OrganizationsService;

beforeEach(() => {
  organizations = new OrganizationsService({ repository: memoryRepository(), logger: silent });
});

function failsWith(code: AppError["code"], path?: string) {
  return (error: unknown) =>
    error instanceof AppError &&
    error.code === code &&
    (path === undefined || (error.details ?? []).some((detail) => detail.path === path));
}

test("a tenant is created active, with its configuration, and its name trimmed", async () => {
  const tenant = await organizations.createTenant({
    name: "  Blue Travel ",
    slug: "blue-travel",
    kind: "travel_agency",
    configuration: { region: "Western Cape" },
  });
  assert.equal(tenant.name, "Blue Travel");
  assert.equal(tenant.status, "active");
  assert.deepEqual(tenant.configuration, { region: "Western Cape" });
  assert.deepEqual(await organizations.getTenantBySlug("blue-travel"), tenant);
});

test("a taken slug is refused on create, while the seed's save still updates it", async () => {
  await organizations.createTenant({ name: "Blue", slug: "blue", kind: "travel_agency" });
  await assert.rejects(
    organizations.createTenant({ name: "Other", slug: "blue", kind: "travel_app" }),
    failsWith("conflict", "slug"),
  );
  const saved = await organizations.saveTenant({ name: "Blue Travel", slug: "blue", kind: "travel_agency" });
  assert.equal(saved.name, "Blue Travel");
  assert.equal((await organizations.listTenants()).length, 1);
});

test("a slug that is not lowercase words joined by single hyphens is refused", async () => {
  for (const slug of ["Blue", "blue travel", "blue--travel", "-blue", "blue-", "blué", "x".repeat(64)]) {
    await assert.rejects(
      organizations.createTenant({ name: "Blue", slug, kind: "travel_agency" }),
      failsWith("invalid_input", "slug"),
      slug,
    );
  }
});

test("a blank name is refused", async () => {
  await assert.rejects(
    organizations.createTenant({ name: "   ", slug: "blue", kind: "travel_agency" }),
    failsWith("invalid_input", "name"),
  );
});

test("an update changes only what it is given, and an unknown slug is not_found", async () => {
  await organizations.createTenant({ name: "Blue", slug: "blue", kind: "travel_agency", configuration: { a: 1 } });
  const suspended = await organizations.updateTenant("blue", { status: "suspended" });
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.name, "Blue");
  assert.deepEqual(suspended.configuration, { a: 1 });

  const renamed = await organizations.updateTenant("blue", { name: "Blue Travel", configuration: { b: 2 } });
  assert.equal(renamed.name, "Blue Travel");
  assert.deepEqual(renamed.configuration, { b: 2 });
  assert.equal(renamed.status, "suspended");

  await assert.rejects(organizations.updateTenant("nowhere", { status: "active" }), failsWith("not_found"));
  await assert.rejects(organizations.updateTenant("blue", {}), failsWith("invalid_input"));
});

test("an unknown tenant is not_found", async () => {
  await assert.rejects(organizations.getTenantBySlug("nowhere"), failsWith("not_found"));
});

test("a user is created in their tenant, a taken email is refused, and the seed's save still updates it", async () => {
  const tenant = await organizations.createTenant({ name: "Blue", slug: "blue", kind: "travel_agency" });
  const ann = await organizations.createUser({
    name: "Ann",
    email: " Ann@Blue.Example.com ",
    role: "client",
    tenantSlug: "blue",
  });
  assert.equal(ann.email, "ann@blue.example.com");
  assert.equal(ann.tenantId, tenant.id);
  assert.deepEqual(await organizations.listUsers(tenant.id), [ann]);

  await assert.rejects(
    organizations.createUser({ name: "Ann", email: "ANN@blue.example.com", role: "client", tenantSlug: "blue" }),
    failsWith("conflict", "email"),
  );
  const saved = await organizations.saveUser({
    name: "Ann Smith",
    email: "ann@blue.example.com",
    role: "client",
    tenantSlug: "blue",
  });
  assert.equal(saved.id, ann.id);
});

test("an email address that is not one is refused", async () => {
  await organizations.createTenant({ name: "Blue", slug: "blue", kind: "travel_agency" });
  for (const email of ["ann", "ann@", "@blue.example.com", "ann@blue", "ann smith@blue.example.com"]) {
    await assert.rejects(
      organizations.createUser({ name: "Ann", email, role: "client", tenantSlug: "blue" }),
      failsWith("invalid_input", "email"),
      email,
    );
  }
});

test("a user for an unknown tenant is not_found", async () => {
  await assert.rejects(
    organizations.createUser({ name: "Ann", email: "ann@blue.example.com", role: "client", tenantSlug: "nowhere" }),
    failsWith("not_found"),
  );
});
