import { z } from "zod";
import type { DomainEvent, DomainEventData } from "../shared/domain-events.ts";

// Catalogue: the experiences as clients see them, and the locations the system covers.
// It calls Data processing for the attribute definitions, to check a search's filters against them.

// ---- Locations ----

export interface Location {
  id: string;
  name: string;
  slug: string;
  country: string;
  region: string;
  timezone: string;
  latitude: number;
  longitude: number;
}

export type SaveLocationInput = Omit<Location, "id">;

// ---- Search ----

// The statuses search can return. Cancelled, Removed and Past experiences are never returned.
export const SEARCHABLE_STATUSES = ["expected", "announced", "confirmed", "postponed"] as const;
export type SearchableStatus = (typeof SEARCHABLE_STATUSES)[number];

export const EXPERIENCE_TYPES = ["single", "run", "recurring"] as const;
export const BOOKING_STATUSES = ["none", "not_yet", "open", "sold_out", "closed"] as const;
export const SESSION_PRECISIONS = ["day", "month", "year"] as const;

const day = z.iso.date();
// Paging, for a search and for changed-since alike.
const limitSchema = z.number({ error: "Give limit as a whole number from 1 to 100." }).int().min(1).max(100);
const offsetSchema = z.number({ error: "Give offset as a whole number, 0 or more." }).int().min(0);

// A filter on one attribute. Text is an option's key or a text value, and a list matches any of its values.
// A range is for number attributes, such as minimum age. A range with only a max also matches an experience that
// has no value for the attribute: nothing recorded means no lower limit, so "at most 12" still finds it. A range
// with a min matches only a recorded value.
export const attributeFilterSchema = z.union(
  [
    z.string().min(1).max(200),
    z.array(z.string().min(1).max(200)).min(1).max(50),
    z.boolean(),
    z.number(),
    z.strictObject({
      min: z.number().optional().describe("The lowest value to match. A range with a min matches only experiences that have a value."),
      max: z.number().optional().describe("The highest value to match. A range with only a max also matches experiences with no value."),
    }),
  ],
  {
    error:
      'Give an attribute filter as an option, such as "music", a list of options, true or false, a number, or a ' +
      'range, such as { "max": 12 }.',
  },
);
export type AttributeFilter = z.infer<typeof attributeFilterSchema>;

// The one search. REST and MCP both take exactly this, so a person and an agent get the same behaviour.
export const searchExperiencesInputSchema = z.strictObject({
  location: z
    .string({ error: "Give location as a place's slug, such as hermanus." })
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "The place to search around, as a location's slug, such as hermanus. The search is around the location's " +
        "centre. Give this or near, not both.",
    ),
  near: z
    .strictObject(
      {
        lat: z
          .number({ error: "Give near.lat, the latitude, as a number from -90 to 90, such as -34.4187." })
          .min(-90)
          .max(90)
          .describe("Latitude in decimal degrees."),
        lng: z
          .number({ error: "Give near.lng, the longitude, as a number from -180 to 180, such as 19.2345." })
          .min(-180)
          .max(180)
          .describe("Longitude in decimal degrees."),
      },
      { error: 'Give near as a point, such as { "lat": -34.4187, "lng": 19.2345 }.' },
    )
    .optional()
    .describe(
      "The point to search around, such as the centre of Hermanus (-34.4187, 19.2345), when the place is not a " +
        "location. Give this or location, not both.",
    ),
  radiusKm: z
    .number({ error: "Give radiusKm as a number of kilometres above 0, such as 30." })
    .positive()
    .optional()
    .describe(
      "How far from the location's centre or the point to search, in kilometres. The default is used when it is " +
        "left out.",
    ),
  from: z.iso
    .date({ error: "Give from, the first day of the stay, as a date such as 2027-06-20." })
    .describe("The first day of the stay, as YYYY-MM-DD."),
  to: z.iso
    .date({ error: "Give to, the last day of the stay, as a date such as 2027-06-27." })
    .describe("The last day of the stay, as YYYY-MM-DD. Must not be before the first day."),
  status: z
    .array(z.enum(SEARCHABLE_STATUSES, { error: "Give each status as expected, announced, confirmed or postponed." }), {
      error: 'Give status as a list, such as ["confirmed"].',
    })
    .min(1)
    .optional()
    .describe("Only experiences with one of these statuses. All four are returned when it is left out."),
  bookable: z
    .boolean({ error: "Give bookable as true or false." })
    .optional()
    .describe(
      "True returns only experiences that can be booked now: confirmed, with booking open, and with a booking link " +
        "or, failing that, their own page to book through.",
    ),
  attributes: z
    .record(z.string().min(1).max(64), attributeFilterSchema, {
      error: 'Give attributes as filters by attribute key, such as { "category": "music" }.',
    })
    .optional()
    .describe(
      "Filters by attribute key, such as category, format, audience, setting, scale, tier or minimum_age. " +
        "Every attribute given must match. A list matches any of its values, and { min, max } is a number range. " +
        "A range with only a max, such as minimum_age: { max: 12 }, also matches experiences with no value " +
        "recorded. A key that is not an attribute, or a value that is not one of its options, is refused, and the " +
        "error lists what can be used. tier is how premium an experience is: luxury, premium, standard or " +
        "everyday; tier: [\"luxury\", \"premium\"] keeps only the premium end.",
    ),
  tags: z
    .array(z.string({ error: "Give each tag as its slug, such as jazz." }).min(1).max(64), {
      error: 'Give tags as a list of 1 to 50 tag slugs, such as ["jazz", "whales"].',
    })
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Tag slugs and season slugs, such as jazz, whales or whale-season. An experience with any one of them " +
        "matches. A slug that is no tag or season is refused, and the error names the closest ones.",
    ),
  query: z
    .string({
      error:
        'Give query as plain words, up to 500 characters, such as "quiet, romantic, something to do with art", or ' +
        "leave it out.",
    })
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "What the traveller likes, in plain words. It only orders the results, best match first within each tier, " +
        "and never adds or removes one. Results are always most premium first, by tier. Put anything that must " +
        "hold in the filters.",
    ),
  limit: limitSchema.default(20).describe("How many experiences to return."),
  offset: offsetSchema.default(0).describe("How many experiences to skip, for paging."),
});
export type SearchExperiencesInput = z.infer<typeof searchExperiencesInputSchema>;

const attributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const sessionResultSchema = z.object({
  startDate: day.describe(
    "The first day it is on, as YYYY-MM-DD. For month or year precision, the month's or year's first day.",
  ),
  endDate: day.describe(
    "The last day of this stretch, as YYYY-MM-DD: the start day for a single day. For month or year precision, the " +
      "month's or year's last day.",
  ),
  precision: z
    .enum(SESSION_PRECISIONS)
    .describe("Month or year means the experience is on in that month or year and its days are not announced yet."),
  startTime: z
    .string()
    .nullable()
    .describe("When it starts, as HH:MM in the experience's timezone. Empty when not stated."),
  endTime: z
    .string()
    .nullable()
    .describe("When it ends, as HH:MM in the experience's timezone. Empty when not stated."),
  label: z
    .string()
    .nullable()
    .describe('The source\'s name for this date, such as "Opening night". Empty when there is none.'),
  soldOut: z.boolean().describe("True when this date is sold out, though others may not be."),
});
export type SessionResult = z.infer<typeof sessionResultSchema>;

// An experience as the repository returns it for a search.
export const experienceRecordSchema = z.object({
  id: z.uuid().describe("The experience's lasting ID. It stays the same across searches and changes."),
  title: z.string().describe("Its name."),
  slug: z.string().describe("A lasting, readable name for it, unique in the feed."),
  summary: z.string().nullable().describe("A sentence or two on what it is. Empty when the source gives none."),
  description: z
    .string()
    .nullable()
    .describe("What the source says about it, at more length. Empty when there is none."),
  type: z
    .enum(EXPERIENCE_TYPES)
    .describe(
      "How its dates are known. single: once, in one stretch. run: several set dates. recurring: repeats by a " +
        "rule, such as every Saturday.",
    ),
  status: z
    .enum(SEARCHABLE_STATUSES)
    .describe(
      "expected: an annual event expected to come round again, with only a month or a year and no announcement " +
        "yet; its dates are likely, not promised. announced: announced, though dates or details may change. " +
        "confirmed: dates fixed and going ahead. postponed: not on its dates, new dates unknown.",
    ),
  booking: z
    .enum(BOOKING_STATUSES)
    .describe(
      "none: nothing to book, such as a market. not_yet: will be bookable; onSaleAt says when, if known. open: can " +
        "be booked now. sold_out: nothing is left. closed: booking has ended.",
    ),
  location: z
    .object({
      slug: z.string().describe("The location's slug, as search takes it, such as hermanus."),
      name: z.string().describe("The location's name, such as Hermanus."),
    })
    .describe("The place in the feed it belongs to."),
  venue: z
    .object({
      name: z.string().nullable().describe("The venue's name. Empty when not stated."),
      address: z.string().nullable().describe("The venue's street address. Empty when not stated."),
      city: z.string().nullable().describe("The town or city the venue is in. Empty when not stated."),
      position: z
        .object({
          lat: z.number().describe("Latitude in decimal degrees."),
          lng: z.number().describe("Longitude in decimal degrees."),
        })
        .nullable()
        .describe(
          "The venue's own coordinates, when the source states them. When empty, distanceKm is measured from the " +
            "location's centre.",
        ),
    })
    .describe("Where it takes place."),
  distanceKm: z.number().describe("The distance from the search point, in kilometres."),
  timezone: z.string().describe("The timezone its times are in, such as Africa/Johannesburg."),
  openingHours: z
    .string()
    .nullable()
    .describe("Opening hours in the source's words, for something open over a period. Empty when not stated."),
  price: z
    .object({
      min: z.number().nullable().describe("The lowest price, in currency."),
      max: z.number().nullable().describe("The highest price, in currency."),
      currency: z.string().nullable().describe("The currency's code, such as ZAR."),
    })
    .describe("The lowest and highest price. A min and max of 0 mean it is free; empty means the source states no price."),
  onSaleAt: z.iso.datetime().nullable().describe("When booking opens, as an ISO timestamp. Empty when not known."),
  bookingClosesAt: z.iso
    .datetime()
    .nullable()
    .describe("When booking closes, as an ISO timestamp. Empty when not known."),
  bookingUrl: z.string().nullable().describe("Where to book it. Empty when the source gives no booking link."),
  imageUrl: z.string().nullable().describe("An image of it, from its source. Empty when there is none."),
  pageUrl: z.string().nullable().describe("The experience's own page, when it has one."),
  attributes: z
    .record(z.string(), z.array(attributeValueSchema))
    .describe(
      "The experience's values by attribute key, such as its categories and its tier: luxury, premium, standard " +
        "or everyday. One with no tier counts as standard.",
    ),
  tags: z
    .array(z.string())
    .describe(
      "Its tag slugs, such as jazz or whales, and season slugs, such as whale-season. A season is given only when " +
        "all of its dates fall inside the season.",
    ),
  sessions: z
    .array(sessionResultSchema)
    .describe("The sessions that fall inside the dates asked for. The experience is on no other day in that range."),
  version: z.number().int().describe("Goes up by one with every real change to the experience."),
  updatedAt: z.iso.datetime().describe("When it last changed, as an ISO timestamp."),
});
export type ExperienceRecord = z.infer<typeof experienceRecordSchema>;

// An experience as a search returns it.
export const experienceResultSchema = experienceRecordSchema.extend({
  bookable: z
    .boolean()
    .describe(
      "True when it can be booked now: confirmed, booking open, and a link to book through, its bookingUrl or, " +
        "failing that, its pageUrl. Everything else is information only.",
    ),
});
export type ExperienceResult = z.infer<typeof experienceResultSchema>;

export const searchExperiencesResultSchema = z
  .object({
    items: z
      .array(experienceResultSchema)
      .describe("The experiences on this page: best match first when a query text is given, otherwise by date."),
    total: z.number().int().describe("How many experiences match, across all pages."),
    limit: z.number().int().describe("The most this page holds, as asked for."),
    offset: z.number().int().describe("How many were skipped before this page, as asked for."),
  })
  .describe("The experiences that are on near the place during the dates and pass every filter.");
export type SearchExperiencesResult = z.infer<typeof searchExperiencesResultSchema>;

// The search as the repository receives it: every default applied and every rule already checked.
export interface ExperienceSearchQuery {
  // The point given, or the centre of the location given.
  near: { lat: number; lng: number };
  radiusKm: number;
  from: string;
  to: string;
  statuses: SearchableStatus[];
  // Set when only experiences that can be booked now may be returned: booking open and a booking link or page
  // address to book through. The statuses then hold Confirmed alone, or nothing.
  bookable?: true;
  attributes: Record<string, AttributeFilter>;
  tags: string[];
  // The query text, which orders the results by keyword and by meaning. It never adds or removes one.
  query?: string;
  // The query text's embedding, and the model that made it. Left out when the model did not answer in time, and
  // the results are then ordered by keyword alone.
  queryEmbedding?: { vector: number[]; model: string };
  // The attribute the results are ordered by before anything else, in the order of its options: the tier, most
  // premium first. An experience with no value counts as `fallback`, or comes last when that is null. Left out when
  // no such attribute is defined, and the order is then as without it.
  rankBy?: { attribute: string; options: string[]; fallback: string | null };
  limit: number;
  offset: number;
}

// ---- Saving experiences ----

// Every experience comes from Data processing, which saves it here. Clients only read.

// The statuses Data processing may set. Removed and Past are set by Catalogue alone.
export const SAVABLE_STATUSES = ["expected", "announced", "confirmed", "postponed", "cancelled"] as const;
export type SavableStatus = (typeof SAVABLE_STATUSES)[number];

export const EXPERIENCE_STATUSES = [...SAVABLE_STATUSES, "removed", "past"] as const;
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

export const CHANGE_KINDS = [
  "new",
  "confirmed",
  "rescheduled",
  "postponed",
  "cancelled",
  "removed",
  "past",
  "changed",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type AttributeValue = string | number | boolean;

// A date a source lists. Dates are YYYY-MM-DD and times HH:MM.
export interface SessionInput {
  // A day, or the first day of the month or year for a session with month or year precision.
  startDate: string;
  // The last day, for several days in a row. Left out, it is the start day, or the end of the month or year.
  endDate?: string;
  precision: "day" | "month" | "year";
  startTime?: string;
  endTime?: string;
  label?: string;
  soldOut?: boolean;
  cancelled?: boolean;
}

// The rule a recurring experience repeats by. Catalogue generates its sessions from it.
export interface RecurrenceInput {
  // An iCalendar recurrence rule, such as FREQ=WEEKLY;BYDAY=SA
  rule: string;
  start: string;
  // Left out when the recurrence is open-ended.
  end?: string;
  startTime?: string;
  endTime?: string;
  // Dates the rule gives on which the experience is not on.
  skipped?: string[];
}

export interface SaveExperienceInput {
  // The experience this updates, as matched by Data processing. Left out, a new experience is created.
  experienceId?: string;
  locationId: string;
  title: string;
  summary?: string;
  description?: string;
  // The short text classification writes, which a search's query text is ranked against.
  profile?: string;
  type: (typeof EXPERIENCE_TYPES)[number];
  status: SavableStatus;
  booking: (typeof BOOKING_STATUSES)[number];
  openingHours?: string;
  venue?: { name?: string; address?: string; city?: string; position?: { lat: number; lng: number } };
  price?: { min?: number; max?: number; currency?: string };
  // ISO timestamps.
  onSaleAt?: string;
  bookingClosesAt?: string;
  bookingUrl?: string;
  imageUrl?: string;
  // The experience's own page, when it has one.
  pageUrl?: string;
  // The dates the listing lists: one for a single, one per date for a run, only the extra dates for a recurring one.
  sessions: SessionInput[];
  recurrence?: RecurrenceInput;
  // The experience's values by attribute key, already checked against the definitions.
  attributes: Record<string, AttributeValue[]>;
  // Tag slugs and season slugs.
  tags: string[];
  // The listing this was built from. The experience gets a source link to it.
  source: { listingId: string; rawListingId: string };
  // How this listing's values meet the ones already stored, decided by Data processing from the source priorities.
  // "lead": this listing is the experience's highest-priority one, so its values replace the stored ones.
  // "fill": a higher-priority listing leads, so this one only fills fields that are empty, and never the dates
  // of an experience that already has some.
  precedence: "lead" | "fill";
}

// An experience as it is stored, with everything that belongs to it.
export interface StoredExperience {
  id: string;
  version: number;
  locationId: string;
  title: string;
  slug: string;
  summary: string | null;
  description: string | null;
  profile: string | null;
  type: (typeof EXPERIENCE_TYPES)[number];
  status: ExperienceStatus;
  booking: (typeof BOOKING_STATUSES)[number];
  timezone: string;
  openingHours: string | null;
  venue: {
    name: string | null;
    address: string | null;
    city: string | null;
    position: { lat: number; lng: number } | null;
  };
  price: { min: number | null; max: number | null; currency: string | null };
  onSaleAt: string | null;
  bookingClosesAt: string | null;
  bookingUrl: string | null;
  imageUrl: string | null;
  pageUrl: string | null;
  recurrence: Required<Pick<RecurrenceInput, "rule" | "start">> & {
    end: string | null;
    startTime: string | null;
    endTime: string | null;
    skipped: string[];
  } | null;
  // Every session, listed and generated, in date order.
  sessions: (SessionResult & { status: "scheduled" | "cancelled"; origin: "listed" | "generated" })[];
  attributes: Record<string, AttributeValue[]>;
  tags: string[];
  // The listings it is linked to, in the order they were linked, the oldest first.
  listingIds: string[];
}

export interface SaveExperienceResult {
  experience: StoredExperience;
  // True when this save created the experience.
  created: boolean;
  // True when this save made a new version. A save that changes nothing makes none.
  changed: boolean;
  // The kind of the change row written, when there is one.
  change: ChangeKind | null;
}

// What Data processing needs to decide whether an extracted experience is one Catalogue already has.
export interface ExperienceMatch {
  id: string;
  title: string;
  type: (typeof EXPERIENCE_TYPES)[number];
  status: ExperienceStatus;
  venueName: string | null;
  city: string | null;
  // The start of its first session and the end of its last. Empty when it has no sessions.
  firstDate: string | null;
  lastDate: string | null;
  // Its sessions' dates, in order, capped to the first fifty.
  sessions: { startDate: string; endDate: string }[];
  // True when its dates are known only to the month or year: it has sessions, every one of month or year
  // precision, and no recurrence.
  onlyMonthOrYear: boolean;
  recurrenceRule: string | null;
  // The listings it is linked to, in the order they were linked, the oldest first. A tie in priority between
  // sources goes to the listing linked first.
  listingIds: string[];
}

// What a search for match candidates is given. The dates are YYYY-MM-DD, both days included.
export interface MatchCandidatesInput {
  locationId: string;
  title: string;
  from: string;
  to: string;
  // Wider dates for an experience whose dates are known only to the month or year.
  monthOrYear?: { from: string; to: string };
}

// ---- Changed since ----

// The statuses changed-since reports. Cancelled and Removed experiences are reported, though search no longer
// returns them. Past ones never are.
export const REPORTED_STATUSES = [...SEARCHABLE_STATUSES, "cancelled", "removed"] as const;
export type ReportedStatus = (typeof REPORTED_STATUSES)[number];

// The kinds of change changed-since reports, what matters most to a planner first. A move to Past is never reported.
export const REPORTED_CHANGE_KINDS = [
  "cancelled",
  "removed",
  "postponed",
  "rescheduled",
  "confirmed",
  "new",
  "changed",
] as const;
export type ReportedChangeKind = (typeof REPORTED_CHANGE_KINDS)[number];

// The same search parameters as a search, without the query text, and the time of the last search.
export const experienceChangesInputSchema = searchExperiencesInputSchema
  .omit({ query: true, status: true, bookable: true, limit: true, offset: true })
  .extend({
    status: searchExperiencesInputSchema.shape.status.describe(
      "Only experiences with one of these statuses. Cancelled and removed experiences are reported whatever it says.",
    ),
    bookable: searchExperiencesInputSchema.shape.bookable.describe(
      "True reports only experiences that can be booked now, confirmed with booking open, and the cancelled and " +
        "removed ones.",
    ),
    since: z.iso
      .datetime({
        offset: true,
        error: "Give since, when you last searched, as a date and time with its time zone, such as 2027-02-01T09:30:00Z.",
      })
      .describe("When you last searched, as an ISO timestamp such as 2027-02-01T09:30:00Z. Only later changes are reported."),
    limit: limitSchema.default(20).describe("How many changed experiences to return."),
    offset: offsetSchema.default(0).describe("How many changed experiences to skip, for paging."),
  });
export type ExperienceChangesInput = z.infer<typeof experienceChangesInputSchema>;

export const reportedChangeSchema = z.object({
  kind: z
    .enum(REPORTED_CHANGE_KINDS)
    .describe(
      "new: first published. confirmed: its dates are now fixed. rescheduled: a date was added, moved or removed. " +
        "postponed: not happening on its dates, new dates unknown. cancelled: called off by its organisers. " +
        "removed: no source lists it any more. changed: anything else, booking and price included.",
    ),
  at: z.iso.datetime().describe("When it changed."),
});
export type ReportedChange = z.infer<typeof reportedChangeSchema>;

export const experienceChangeSchema = z.object({
  experience: experienceResultSchema.extend({
    status: z.enum(REPORTED_STATUSES).describe("Cancelled and removed experiences are final."),
    sessions: z
      .array(sessionResultSchema)
      .describe(
        "The sessions inside the dates asked for. When movedOut is true it has none there, and these are the " +
          "sessions it has now, all outside the dates: where it moved to. Empty when it has no dates left.",
      ),
  }).describe("The experience as it is now, as a search returns it."),
  movedOut: z
    .boolean()
    .describe(
      "True when the experience was on during the dates asked for before a change since then, and is not on " +
        "during them now: it moved out of the dates, or its sessions in them were dropped or cancelled. Treat it " +
        "as no longer on during the stay.",
    ),
  change: reportedChangeSchema.describe("The change that matters most to a planner."),
  changes: z.array(reportedChangeSchema).describe("Every change since the time given, newest first."),
});
export type ExperienceChange = z.infer<typeof experienceChangeSchema>;

export const experienceChangesResultSchema = z
  .object({
    items: z.array(experienceChangeSchema).describe("The experiences that changed, the most recent change first."),
    total: z.number().int().describe("How many experiences changed, across all pages."),
    limit: z.number().int().describe("The most this page holds, as asked for."),
    offset: z.number().int().describe("How many were skipped before this page, as asked for."),
  })
  .describe("The experiences that changed since the time given, among those the search parameters select.");
export type ExperienceChangesResult = z.infer<typeof experienceChangesResultSchema>;

// Changed-since as the repository receives it: every default applied and every rule already checked.
// Changed-since keeps its own order, most recent change first, so it is not ranked by tier.
export interface ExperienceChangesQuery extends Omit<ExperienceSearchQuery, "query" | "queryEmbedding" | "rankBy"> {
  since: Date;
}

// An experience that changed, as the repository returns it.
export interface ChangedExperienceRecord {
  experience: Omit<ExperienceRecord, "status"> & { status: ReportedStatus };
  // True when it was matched on the sessions it had before a change after the time given, and has none in the dates
  // now. Its sessions are then the ones it has now.
  movedOut: boolean;
  // Its changes after the time given, newest first. Moves to Past are left out.
  changes: { kind: Exclude<ChangeKind, "past">; at: string }[];
}

// ---- Upkeep ----

// What one run of Catalogue's upkeep did.
export interface UpkeepResult {
  // Experiences set to Past.
  past: number;
  // Experiences whose booking was closed because the close time passed.
  bookingsClosed: number;
  // Sessions generated further ahead for open-ended recurring experiences.
  sessionsGenerated: number;
}

// ---- Embeddings ----

// The embedding model port. Catalogue embeds each experience's title and profile, and a search's query text, to
// order a search's results by meaning. The adapter owns everything about the provider: its SDK, model name,
// credentials, limits and how its failures are read.
export interface EmbeddingModel {
  // The model's name, saved with every embedding. A different name makes every experience be embedded again.
  model: string;
  // How many numbers an embedding has. Must be 1024, the size of the column.
  dimensions: number;
  // One embedding per text, in the order of the texts. A profile is a document and a query text is a query; a
  // model that embeds the two the same way ignores the purpose. Fails only with EmbeddingFailed.
  embed(texts: string[], purpose: "document" | "query"): Promise<number[][]>;
}

// The one kind of failure `embed` has. A text too long for the model is one, and is never cut to fit.
export class EmbeddingFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingFailed";
  }
}

// An experience whose embedding is due, with what it is embedded from.
export interface ExperienceToEmbed {
  id: string;
  title: string;
  profile: string | null;
}

// One round of embedding.
export interface EmbedExperiencesResult {
  // Experiences given an embedding this round.
  embedded: number;
  // Experiences whose text the model failed on. Each failure is counted, and they are taken again in a later round.
  failed: number;
  // Of the failed ones, those whose text the model has now failed on EMBEDDING_MAX_ATTEMPTS times. They are not
  // taken again until their title or profile changes.
  setAside: number;
  // Experiences still due after this round, the failed ones included and the ones set aside left out.
  remaining: number;
}

// ---- Ports ----

// Inbound port: what Catalogue offers.
export interface Catalogue {
  // Experiences near a location's centre or a point that have a session inside the dates, with the sessions that
  // matched. Fails with invalid_input when the location does not exist or an attribute filter does not fit the
  // attribute definitions.
  searchExperiences(input: SearchExperiencesInput): Promise<SearchExperiencesResult>;
  // Creates the location, or updates the one that has this slug.
  saveLocation(input: SaveLocationInput): Promise<Location>;
  getLocation(by: { id: string } | { slug: string }): Promise<Location | null>;
  // One experience whole, whatever its status, by its ID or its slug. Null when there is none.
  getExperience(by: { id: string } | { slug: string }): Promise<StoredExperience | null>;

  // The experiences a listing is linked to, whatever their status.
  findExperiencesByListing(listingId: string): Promise<ExperienceMatch[]>;
  // Experiences in the same location with a session overlapping the dates and a similar title. When `monthOrYear`
  // is given, an experience whose dates are known only to the month or year is also a candidate when a session
  // overlaps those wider dates. Cancelled, Removed and Past experiences are never candidates.
  findMatchCandidates(input: MatchCandidatesInput): Promise<ExperienceMatch[]>;
  // Creates or updates an experience with its sessions, attribute values, tags and source link. It bumps the
  // version, writes the change row and appends the domain event when something really changed.
  saveExperience(input: SaveExperienceInput): Promise<SaveExperienceResult>;
  // Removes a listing's link from one experience, or from every experience it links to when none is named.
  // An experience left with no links is set to Removed, unless it is already Past or Cancelled.
  // Returns the IDs of the experiences that lost the link.
  removeSourceLink(input: { listingId: string; experienceId?: string; rawListingId: string }): Promise<string[]>;
  // What changed since a time among the experiences the search parameters select: new, confirmed, rescheduled,
  // postponed, cancelled, removed or otherwise changed. Cancelled and Removed ones are reported; Past ones never are.
  // One that was on during the dates before a change since then, and is not now, is reported as moved out.
  getChangesSince(input: ExperienceChangesInput): Promise<ExperienceChangesResult>;
  // Catalogue's scheduled upkeep: sets finished experiences to Past, closes bookings whose close time has passed,
  // and generates the sessions of open-ended recurring experiences further ahead.
  keepUp(): Promise<UpkeepResult>;
  // One round of embedding: up to a batch of the experiences search can return whose embedding is empty or was
  // made by another model, leaving out those set aside. Storing an embedding makes no new version, change row or
  // domain event. Fails with unavailable when the model failed on every text and on a test text too.
  embedExperiences(): Promise<EmbedExperiencesResult>;
}

// One experience's save as the service decided it. The repository stores it as it is handed.
export interface ExperienceWrite {
  // The experience as it is to be stored.
  experience: StoredExperience;
  // The version stored before this save, so a save made at the same time is caught. Null when it creates.
  previousVersion: number | null;
  // Which of its parts are stored again, whole, from `experience`.
  replace: { sessions: boolean; attributes: boolean; tags: boolean };
  links: { add: string[]; remove: string[] };
  // True when the title or the profile changed, so the embedding no longer fits.
  clearEmbedding: boolean;
  // The change row of a new version, whose number is `experience.version`.
  change: { kind: ChangeKind; previous: Record<string, unknown> | null } | null;
  // The domain event of a new version, appended with it.
  event:
    | { type: "experience.published"; data: DomainEventData["experience.published"] }
    | { type: "experience.changed"; data: DomainEventData["experience.changed"] }
    | null;
  at: Date;
}

// Outbound port: what Catalogue needs.
export interface CatalogueRepository {
  searchExperiences(query: ExperienceSearchQuery): Promise<{ items: ExperienceRecord[]; total: number }>;
  upsertLocation(input: SaveLocationInput): Promise<Location>;
  findLocation(by: { id: string } | { slug: string }): Promise<Location | null>;
  // Experiences whole, by ID or by a listing they are linked to.
  loadExperiences(by: { ids: string[] } | { listingId: string }): Promise<StoredExperience[]>;
  // The ID of the experience with this ID or this slug, or null when there is none.
  findExperienceId(by: { id: string } | { slug: string }): Promise<string | null>;
  // The IDs of the match candidates, best match first.
  findMatchCandidateIds(query: MatchCandidatesInput & { limit: number }): Promise<string[]>;
  // The slugs that are the base or start with it and a hyphen.
  findTakenSlugs(base: string): Promise<string[]>;
  // Stores the saves in one transaction. Returns the domain events it appended, as stored, in the order of the
  // saves; it does not publish them.
  saveExperiences(writes: ExperienceWrite[]): Promise<DomainEvent[]>;
  // A page of the experiences changed-since reports, the most recent change first, and how many there are.
  findChangesSince(query: ExperienceChangesQuery): Promise<{ items: ChangedExperienceRecord[]; total: number }>;
  // Up to `limit` IDs, in order after `after`, of the experiences the upkeep may have work on: Expected, Announced
  // or Confirmed ones whose last session ends before `lastDateBefore`, ones with booking Not yet or Open whose close
  // time is at or before `bookingClosedBy`, and open-ended recurring ones that are not final.
  findUpkeepCandidates(query: {
    lastDateBefore: string;
    bookingClosedBy: Date;
    after: string | null;
    limit: number;
  }): Promise<string[]>;
  // Up to `limit` searchable experiences with no embedding from this model and fewer than `maxAttempts` failures,
  // oldest first, and how many there are.
  findExperiencesToEmbed(query: {
    model: string;
    limit: number;
    maxAttempts: number;
  }): Promise<{ items: ExperienceToEmbed[]; total: number }>;
  // Stores each embedding with the model's name, on an experience whose title and profile are still the ones it was
  // made from. The version, the update time, the change rows and the domain events are left as they are. Returns
  // how many it stored.
  // A stored embedding clears the failure count.
  storeEmbeddings(input: { model: string; embeddings: (ExperienceToEmbed & { vector: number[] })[] }): Promise<number>;
  // Counts one more failure of the model on each experience's text, if its title and profile are still the ones the
  // text was made from. Returns the IDs of those whose count has now reached `maxAttempts`, which are set aside.
  recordEmbeddingFailures(input: { experiences: ExperienceToEmbed[]; maxAttempts: number }): Promise<string[]>;
}
