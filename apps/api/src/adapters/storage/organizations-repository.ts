import { randomUUID } from "node:crypto";
import { tenant, user, type Db } from "@magic-events/db";
import { eq, sql } from "drizzle-orm";
import type { Membership, OrganizationsRepository, Tenant, User } from "../../core/organizations/ports.ts";

// Tenants are Organizations' own table. Users, membership and roles are on Better Auth's user table, which
// Organizations uses directly (the documented exception), so a user saved here is the user Better Auth knows.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TenantRow = typeof tenant.$inferSelect;
type UserRow = typeof user.$inferSelect;

export function createOrganizationsRepository(db: Db): OrganizationsRepository {
  return {
    async upsertTenant(input) {
      const [row] = await db
        .insert(tenant)
        .values(input)
        .onConflictDoUpdate({
          target: tenant.slug,
          set: {
            name: input.name,
            kind: input.kind,
            status: input.status,
            configuration: input.configuration,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      if (!row) throw new Error("The tenant upsert returned no row");
      return toTenant(row);
    },

    async findTenantById(id) {
      // The ID column is a UUID, so anything else names no tenant.
      if (!UUID.test(id)) return null;
      const [row] = await db.select().from(tenant).where(eq(tenant.id, id));
      return row ? toTenant(row) : null;
    },

    async findTenantBySlug(slug) {
      const [row] = await db.select().from(tenant).where(eq(tenant.slug, slug));
      return row ? toTenant(row) : null;
    },

    async upsertUser(input) {
      const [row] = await db
        .insert(user)
        // Better Auth keeps its IDs as text, and accepts any unique string.
        .values({ id: randomUUID(), ...input })
        .onConflictDoUpdate({
          target: user.email,
          set: { name: input.name, role: input.role, tenantId: input.tenantId, updatedAt: sql`now()` },
        })
        .returning();
      if (!row) throw new Error("The user upsert returned no row");
      return toUser(row);
    },

    async findMembership(userId): Promise<Membership | null> {
      const [row] = await db.select().from(user).leftJoin(tenant, eq(user.tenantId, tenant.id)).where(eq(user.id, userId));
      if (!row) return null;
      return { user: toUser(row.user), tenant: row.tenant ? toTenant(row.tenant) : null };
    },
  };
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    configuration: row.configuration,
  };
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, email: row.email, role: row.role, tenantId: row.tenantId };
}
