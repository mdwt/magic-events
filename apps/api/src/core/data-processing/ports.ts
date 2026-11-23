import type { RequeueResult } from "../discovery/ports.ts";

// Data processing: turns raw listings into clean, categorised, tagged experiences.
// It calls Discovery and Catalogue. It owns the attribute, option and tag definitions and the seasons.

export type AttributeType = "option" | "text" | "number" | "boolean" | "date";

export interface AttributeOption {
  key: string;
  name: string;
  // The context the classifier reads to decide when the option applies.
  description: string;
}

export interface AttributeDefinition {
  key: string;
  name: string;
  description: string;
  type: AttributeType;
  defaultValue: string | number | boolean | null;
  // Whether an experience can have several values for it.
  multiple: boolean;
  // Whether clients can filter on it.
  filterable: boolean;
  // The allowed values of an option attribute, in order. Empty for the other types.
  options: AttributeOption[];
}

export interface TagDefinition {
  slug: string;
  name: string;
  description: string;
}

export interface SeasonPeriod {
  startDate: string;
  endDate: string;
}

export interface Season {
  id: string;
  locationId: string;
  slug: string;
  name: string;
  description: string;
  periods: SeasonPeriod[];
}

export interface SaveSeasonInput {
  // The slug of the location the season applies to.
  locationSlug: string;
  slug: string;
  name: string;
  description: string;
  periods: SeasonPeriod[];
}

// What became of one raw listing.
export interface ProcessingOutcome {
  rawListingId: string;
  listingId: string;
  sourceName: string;
  // "failed" carries the error. A failed raw listing is retried until it reaches its source's max processing attempts.
  outcome: "processed" | "failed";
  // How many experiences it produced, and how many of those were new or really changed.
  experiences: number;
  created: number;
  changed: number;
  // How many experiences lost their link to this listing.
  unlinked: number;
  error: string | null;
}

// What to process again: one listing, every listing an experience was built from, every listing of a source, or
// every listing of a location. An experience is named by its ID or its slug, a source by its name.
export type ReprocessTarget =
  | { listingId: string }
  | { experienceId: string }
  | { sourceName: string }
  | { locationSlug: string };

// Inbound port: what Data processing offers.
export interface DataProcessing {
  // Claims one pending raw listing and processes it in one transaction: extract, classify, match, save, append
  // to the data warehouse, mark. Returns null when nothing is pending. A failure never throws: nothing from that
  // raw listing is saved, it is marked failed, and the outcome says so.
  processNext(): Promise<ProcessingOutcome | null>;
  // Processes pending raw listings one after another until none is left, or until the limit is reached.
  processPending(options?: { limit?: number }): Promise<ProcessingOutcome[]>;
  // Sends the target's listings back for processing: the latest version of each goes back to pending through
  // Discovery. It only sends them back; the processing job, or processPending, processes them.
  reprocess(target: ReprocessTarget): Promise<RequeueResult>;

  // Creates the attribute with its options, or updates the one that has this key. Options left out are removed.
  saveAttribute(input: AttributeDefinition): Promise<AttributeDefinition>;
  // Creates the tag, or updates the one that has this slug.
  saveTag(input: TagDefinition): Promise<TagDefinition>;
  // Creates the season with its periods, or updates the one that has this slug in this location.
  saveSeason(input: SaveSeasonInput): Promise<Season>;
}

// One experience as processing saved it, appended to the data warehouse.
export interface WarehouseRow {
  experienceId: string;
  rawListingId: string;
  version: number;
  // The experience as Catalogue saved it.
  experience: Record<string, unknown>;
}

// An attribute, option or tag the classifier returned that is not defined, saved for review.
export interface UndefinedValueRow {
  rawListingId: string;
  kind: "attribute" | "option" | "tag";
  value: string;
  extractedExperience: Record<string, unknown>;
  // The model's whole answer.
  modelAnswer: Record<string, unknown>;
}

// Outbound port: what Data processing needs.
export interface DataProcessingRepository {
  upsertAttribute(input: AttributeDefinition): Promise<AttributeDefinition>;
  upsertTag(input: TagDefinition): Promise<TagDefinition>;
  upsertSeason(input: Omit<Season, "id">): Promise<Season>;
  // Every attribute with its options in order, and every tag, each ordered by key or slug.
  listDefinitions(): Promise<{ attributes: AttributeDefinition[]; tags: TagDefinition[] }>;
  // The seasons of a location, with their periods.
  listSeasons(locationId: string): Promise<Season[]>;
  appendWarehouseRows(rows: WarehouseRow[]): Promise<void>;
  saveUndefinedValues(rows: UndefinedValueRow[]): Promise<void>;
}
