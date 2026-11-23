import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// Catalogue owns these tables. Only the Catalogue repository writes them.

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const experienceType = pgEnum("experience_type", ["single", "run", "recurring"]);

export const experienceStatus = pgEnum("experience_status", [
  "expected",
  "announced",
  "confirmed",
  "postponed",
  "cancelled",
  "removed",
  "past",
]);

export const bookingStatus = pgEnum("booking_status", ["none", "not_yet", "open", "sold_out", "closed"]);

export const sessionPrecision = pgEnum("session_precision", ["day", "month", "year"]);

export const sessionStatus = pgEnum("session_status", ["scheduled", "cancelled"]);

// Whether a source listed the session or Catalogue generated it from a recurrence.
export const sessionOrigin = pgEnum("session_origin", ["listed", "generated"]);

export const changeKind = pgEnum("change_kind", [
  "new",
  "confirmed",
  "rescheduled",
  "postponed",
  "cancelled",
  "removed",
  "past",
  "changed",
]);

export const location = pgTable(
  "location",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    country: text("country").notNull(),
    region: text("region").notNull(),
    timezone: text("timezone").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("location_slug_idx").on(t.slug)],
);

export const experience = pgTable(
  "experience",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => location.id),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary"),
    description: text("description"),
    // Written by classification on every processing. The text a query is ranked against.
    profile: text("profile"),
    type: experienceType("type").notNull(),
    status: experienceStatus("status").notNull(),
    booking: bookingStatus("booking").notNull(),
    timezone: text("timezone").notNull(),
    openingHours: text("opening_hours"),

    venueName: text("venue_name"),
    venueAddress: text("venue_address"),
    city: text("city"),
    // The venue's own position. Optional; the location's centre stands in when it is missing.
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),

    priceMin: numeric("price_min", { precision: 12, scale: 2, mode: "number" }),
    priceMax: numeric("price_max", { precision: 12, scale: 2, mode: "number" }),
    currency: text("currency"),
    onSaleAt: timestamp("on_sale_at", { withTimezone: true }),
    bookingClosesAt: timestamp("booking_closes_at", { withTimezone: true }),
    bookingUrl: text("booking_url"),
    imageUrl: text("image_url"),
    // The experience's own page, when it has one other than the listing it came from.
    pageUrl: text("page_url"),

    // The recurrence of a recurring experience. All empty for a single or a run.
    recurrenceRule: text("recurrence_rule"),
    recurrenceStart: date("recurrence_start"),
    recurrenceEnd: date("recurrence_end"),
    recurrenceStartTime: time("recurrence_start_time"),
    recurrenceEndTime: time("recurrence_end_time"),
    recurrenceSkipped: date("recurrence_skipped").array(),

    version: integer("version").notNull().default(1),

    embedding: vector("embedding", { dimensions: 1024 }),
    embeddingModel: text("embedding_model"),
    // How many times the embedding model failed on its text, while the model answered for others. Cleared with the
    // embedding when the title or profile changes. At EMBEDDING_MAX_ATTEMPTS it is set aside and not tried again.
    embeddingFailures: integer("embedding_failures").notNull().default(0),
    // The keyword side of search. Postgres keeps it up to date itself.
    searchText: tsvector("search_text").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(description, '') || ' ' || coalesce(profile, ''))`,
    ),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("experience_slug_idx").on(t.slug),
    index("experience_location_idx").on(t.locationId),
    index("experience_status_idx").on(t.status),
    index("experience_search_text_idx").using("gin", t.searchText),
  ],
);

export const experienceSession = pgTable(
  "experience_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    // A session with month or year precision sits on the month's or year's boundaries.
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    precision: sessionPrecision("precision").notNull().default("day"),
    startTime: time("start_time"),
    endTime: time("end_time"),
    label: text("label"),
    status: sessionStatus("status").notNull().default("scheduled"),
    soldOut: boolean("sold_out").notNull().default(false),
    origin: sessionOrigin("origin").notNull().default("listed"),
  },
  (t) => [
    index("experience_session_experience_idx").on(t.experienceId),
    index("experience_session_dates_idx").on(t.startDate, t.endDate),
    check("experience_session_dates_check", sql`${t.endDate} >= ${t.startDate}`),
  ],
);

// One row per value, so an attribute that takes several values has several rows.
// The key is the attribute definition's key; an option attribute's value is the option's key.
export const experienceAttributeValue = pgTable(
  "experience_attribute_value",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    attributeKey: text("attribute_key").notNull(),
    value: jsonb("value").$type<string | number | boolean>().notNull(),
  },
  (t) => [
    uniqueIndex("experience_attribute_value_idx").on(t.experienceId, t.attributeKey, t.value),
    index("experience_attribute_value_lookup_idx").on(t.attributeKey, t.value),
  ],
);

// Tag slugs and season slugs. A tag appears once per experience.
export const experienceTag = pgTable(
  "experience_tag",
  {
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [primaryKey({ columns: [t.experienceId, t.tag] }), index("experience_tag_tag_idx").on(t.tag)],
);

// A listing this experience was built from. The listing is Discovery's; only its ID is held.
export const experienceSourceLink = pgTable(
  "experience_source_link",
  {
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.experienceId, t.listingId] }),
    index("experience_source_link_listing_idx").on(t.listingId),
  ],
);

// One row per version. Feeds changed-since.
export const experienceChange = pgTable(
  "experience_change",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    kind: changeKind("kind").notNull(),
    previous: jsonb("previous").$type<Record<string, unknown>>(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("experience_change_version_idx").on(t.experienceId, t.version),
    index("experience_change_changed_at_idx").on(t.changedAt),
  ],
);
