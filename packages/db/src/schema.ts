import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    globalPosition: bigint("global_position", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid("id").notNull().defaultRandom(),
    streamId: text("stream_id").notNull(),
    streamVersion: integer("stream_version").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("events_id_idx").on(t.id),
    uniqueIndex("events_stream_version_idx").on(t.streamId, t.streamVersion),
    index("events_type_idx").on(t.type),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
