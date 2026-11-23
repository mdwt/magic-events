import { sql } from "drizzle-orm";
import {
  boolean,
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
import { location } from "./catalogue.ts";

// Discovery owns these tables. Only the Discovery repository writes them.

export const runStatus = pgEnum("run_status", ["running", "succeeded", "failed"]);

export const listingState = pgEnum("listing_state", ["listed", "removed"]);

export const rawListingStatus = pgEnum("raw_listing_status", ["pending", "processed", "failed", "superseded"]);

// Listing is fetched content. Removed means the listing is gone from the source and has no content.
export const rawListingKind = pgEnum("raw_listing_kind", ["listing", "removed"]);

export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Picks the adapter that fetches it and the extractor that reads it. Not an enum: a kind is added with its adapter.
    kind: text("kind").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => location.id),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    // The name of the setting that holds the API key. The key itself is never stored here.
    credentialsSetting: text("credentials_setting"),
    syncState: jsonb("sync_state").$type<Record<string, unknown>>().notNull().default({}),
    // When sources disagree, an experience's fields come from the listing of the source with the highest priority.
    priority: integer("priority").notNull().default(0),
    fetchIntervalHours: integer("fetch_interval_hours").notNull(),
    missedRunsBeforeRemoval: integer("missed_runs_before_removal").notNull(),
    maxProcessingAttempts: integer("max_processing_attempts").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("source_name_location_idx").on(t.name, t.locationId)],
);

export const run = pgTable(
  "run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: runStatus("status").notNull().default("running"),
    // Whether the run returned everything the source currently lists. Only complete runs count towards a missed listing.
    complete: boolean("complete").notNull().default(false),
    listingsFound: integer("listings_found").notNull().default(0),
    listingsNewOrChanged: integer("listings_new_or_changed").notNull().default(0),
    listingsUnchanged: integer("listings_unchanged").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("run_source_started_idx").on(t.sourceId, t.startedAt)],
);

export const listing = pgTable(
  "listing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id),
    // The source's own ID for the listing, or its web address if the source has none.
    sourceListingId: text("source_listing_id").notNull(),
    url: text("url"),
    firstSeenRunId: uuid("first_seen_run_id")
      .notNull()
      .references(() => run.id),
    lastSeenRunId: uuid("last_seen_run_id")
      .notNull()
      .references(() => run.id),
    // A hash of the content last fetched.
    fingerprint: text("fingerprint").notNull(),
    state: listingState("state").notNull().default("listed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("listing_source_listing_idx").on(t.sourceId, t.sourceListingId)],
);

export const rawListing = pgTable(
  "raw_listing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listing.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id),
    kind: rawListingKind("kind").notNull().default("listing"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    // Empty for a raw listing of kind removed.
    contentType: text("content_type"),
    // Exactly as the source returned it. A PDF is stored as base64. Never changed after it is saved.
    content: text("content"),
    fingerprint: text("fingerprint"),
    status: rawListingStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    index("raw_listing_listing_idx").on(t.listingId, t.fetchedAt),
    index("raw_listing_pending_idx").on(t.fetchedAt).where(sql`${t.status} = 'pending'`),
  ],
);
