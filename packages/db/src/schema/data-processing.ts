import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { experience, location } from "./catalogue.ts";
import { rawListing } from "./discovery.ts";

// Data processing owns these tables. Only the Data processing repository writes them.

export const attributeType = pgEnum("attribute_type", ["option", "text", "number", "boolean", "date"]);

export const undefinedValueKind = pgEnum("undefined_value_kind", ["attribute", "option", "tag"]);

// Attributes, their options and tags are rows, not enums. The description is what the classifier reads.
export const attribute = pgTable(
  "attribute",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    type: attributeType("type").notNull(),
    defaultValue: jsonb("default_value").$type<string | number | boolean>(),
    multiple: boolean("multiple").notNull().default(false),
    filterable: boolean("filterable").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("attribute_key_idx").on(t.key)],
);

export const attributeOption = pgTable(
  "attribute_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => attribute.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [uniqueIndex("attribute_option_key_idx").on(t.attributeId, t.key)],
);

export const tag = pgTable(
  "tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tag_slug_idx").on(t.slug)],
);

// A named period of the year in one location. Not an experience.
export const season = pgTable(
  "season",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => location.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("season_location_slug_idx").on(t.locationId, t.slug)],
);

// The dates of a season. A season that comes round every year has one row per year.
export const seasonPeriod = pgTable(
  "season_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => season.id, { onDelete: "cascade" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
  },
  (t) => [
    uniqueIndex("season_period_idx").on(t.seasonId, t.startDate),
    check("season_period_dates_check", sql`${t.endDate} >= ${t.startDate}`),
  ],
);

// The data warehouse. One row per experience, per processing. Append only.
export const warehouseExperience = pgTable(
  "warehouse_experience",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experience.id),
    rawListingId: uuid("raw_listing_id")
      .notNull()
      .references(() => rawListing.id),
    version: integer("version").notNull(),
    // The experience as Catalogue saved it.
    experience: jsonb("experience").$type<Record<string, unknown>>().notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("warehouse_experience_experience_idx").on(t.experienceId, t.recordedAt)],
);

// An attribute, option or tag the classifier returned that is not defined. Saved for review; nothing reads it.
export const undefinedValue = pgTable(
  "undefined_value",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rawListingId: uuid("raw_listing_id")
      .notNull()
      .references(() => rawListing.id),
    kind: undefinedValueKind("kind").notNull(),
    value: text("value").notNull(),
    extractedExperience: jsonb("extracted_experience").$type<Record<string, unknown>>().notNull(),
    modelAnswer: jsonb("model_answer").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("undefined_value_raw_listing_idx").on(t.rawListingId)],
);
