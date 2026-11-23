import { z } from "zod";

// Catalogue: the experiences as clients see them, and the locations the system covers.
// It calls no other domain.

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

// A filter on one attribute. Text is an option's key or a text value, and a list matches any of its values.
// A range is for number attributes, such as minimum age.
export const attributeFilterSchema = z.union([
  z.string().min(1).max(200),
  z.array(z.string().min(1).max(200)).min(1).max(50),
  z.boolean(),
  z.number(),
  z.strictObject({ min: z.number().optional(), max: z.number().optional() }),
]);
export type AttributeFilter = z.infer<typeof attributeFilterSchema>;

// The one search. REST and MCP both take exactly this, so a person and an agent get the same behaviour.
export const searchExperiencesInputSchema = z.strictObject({
  near: z
    .strictObject({
      lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees."),
      lng: z.number().min(-180).max(180).describe("Longitude in decimal degrees."),
    })
    .describe("The point to search around, such as the centre of Hermanus (-34.4187, 19.2345)."),
  radiusKm: z
    .number()
    .positive()
    .optional()
    .describe("How far from the point to search, in kilometres. The default is used when it is left out."),
  from: day.describe("The first day of the stay, as YYYY-MM-DD."),
  to: day.describe("The last day of the stay, as YYYY-MM-DD. Must not be before the first day."),
  status: z
    .array(z.enum(SEARCHABLE_STATUSES))
    .min(1)
    .optional()
    .describe("Only experiences with one of these statuses. All four are returned when it is left out."),
  bookable: z
    .boolean()
    .optional()
    .describe("True returns only experiences that can be booked now: confirmed, with booking open."),
  attributes: z
    .record(z.string().min(1).max(64), attributeFilterSchema)
    .optional()
    .describe(
      "Filters by attribute key, such as category, format, audience, setting, scale or minimum_age. " +
        "Every attribute given must match. A list matches any of its values, and { min, max } is a number range.",
    ),
  tags: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(50)
    .optional()
    .describe("Tag slugs, such as jazz or whales. An experience with any one of them matches."),
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "What the traveller likes, in plain words. It only orders the results, best match first, " +
        "and never adds or removes one. Put anything that must hold in the filters.",
    ),
  limit: z.number().int().min(1).max(100).default(20).describe("How many experiences to return."),
  offset: z.number().int().min(0).default(0).describe("How many experiences to skip, for paging."),
});
export type SearchExperiencesInput = z.infer<typeof searchExperiencesInputSchema>;

const attributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const sessionResultSchema = z.object({
  startDate: day,
  endDate: day,
  precision: z
    .enum(SESSION_PRECISIONS)
    .describe("Month or year means the experience is on in that month or year and its days are not announced yet."),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  label: z.string().nullable(),
  soldOut: z.boolean(),
});
export type SessionResult = z.infer<typeof sessionResultSchema>;

// An experience as the repository returns it for a search.
export const experienceRecordSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  slug: z.string(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  type: z.enum(EXPERIENCE_TYPES),
  status: z.enum(SEARCHABLE_STATUSES),
  booking: z.enum(BOOKING_STATUSES),
  location: z.object({ slug: z.string(), name: z.string() }),
  venue: z.object({
    name: z.string().nullable(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    position: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  }),
  distanceKm: z.number().describe("The distance from the search point, in kilometres."),
  timezone: z.string(),
  openingHours: z.string().nullable(),
  price: z.object({ min: z.number().nullable(), max: z.number().nullable(), currency: z.string().nullable() }),
  onSaleAt: z.iso.datetime().nullable(),
  bookingClosesAt: z.iso.datetime().nullable(),
  bookingUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  attributes: z
    .record(z.string(), z.array(attributeValueSchema))
    .describe("The experience's values by attribute key, such as its categories."),
  tags: z.array(z.string()),
  sessions: z
    .array(sessionResultSchema)
    .describe("The sessions that fall inside the dates asked for. The experience is on no other day in that range."),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type ExperienceRecord = z.infer<typeof experienceRecordSchema>;

// An experience as a search returns it.
export const experienceResultSchema = experienceRecordSchema.extend({
  bookable: z.boolean().describe("True when it can be booked now. Everything else is information only."),
});
export type ExperienceResult = z.infer<typeof experienceResultSchema>;

export const searchExperiencesResultSchema = z.object({
  items: z.array(experienceResultSchema),
  total: z.number().int().describe("How many experiences match, across all pages."),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type SearchExperiencesResult = z.infer<typeof searchExperiencesResultSchema>;

// The search as the repository receives it: every default applied and every rule already checked.
export interface ExperienceSearchQuery {
  near: { lat: number; lng: number };
  radiusKm: number;
  from: string;
  to: string;
  statuses: SearchableStatus[];
  // Set when only some booking values may be returned.
  bookings?: (typeof BOOKING_STATUSES)[number][];
  attributes: Record<string, AttributeFilter>;
  tags: string[];
  query?: string;
  limit: number;
  offset: number;
}

// ---- Ports ----

// Inbound port: what Catalogue offers.
export interface Catalogue {
  // Experiences near a point that have a session inside the dates, with the sessions that matched.
  searchExperiences(input: SearchExperiencesInput): Promise<SearchExperiencesResult>;
  // Creates the location, or updates the one that has this slug.
  saveLocation(input: SaveLocationInput): Promise<Location>;
  getLocation(by: { id: string } | { slug: string }): Promise<Location | null>;
}

// Outbound port: what Catalogue needs.
export interface CatalogueRepository {
  searchExperiences(query: ExperienceSearchQuery): Promise<{ items: ExperienceRecord[]; total: number }>;
  upsertLocation(input: SaveLocationInput): Promise<Location>;
  findLocation(by: { id: string } | { slug: string }): Promise<Location | null>;
}
