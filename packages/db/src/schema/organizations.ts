import { jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Organizations owns the tenant table. Users, membership and roles are on Better Auth's user table (see identity.ts).

export const tenantKind = pgEnum("tenant_kind", ["travel_agency", "travel_app"]);

export const tenantStatus = pgEnum("tenant_status", ["active", "suspended"]);

export const tenant = pgTable(
  "tenant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: tenantKind("kind").notNull(),
    status: tenantStatus("status").notNull().default("active"),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tenant_slug_idx").on(t.slug)],
);
