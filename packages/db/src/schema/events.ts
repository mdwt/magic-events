import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// The domain event log. Append only, and it belongs to no domain: the repository of the domain that makes
// a change appends its own domain events in the same transaction. Nothing reads it.
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // resource.verb, such as experience.changed
    type: text("type").notNull(),
    // The raw listing or the experience the domain event is about. The type says which.
    resourceId: uuid("resource_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_resource_idx").on(t.resourceId, t.recordedAt)],
);
