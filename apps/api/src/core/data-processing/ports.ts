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

// Inbound port: what Data processing offers.
export interface DataProcessing {
  // Creates the attribute with its options, or updates the one that has this key. Options left out are removed.
  saveAttribute(input: AttributeDefinition): Promise<AttributeDefinition>;
  // Creates the tag, or updates the one that has this slug.
  saveTag(input: TagDefinition): Promise<TagDefinition>;
  // Creates the season with its periods, or updates the one that has this slug in this location.
  saveSeason(input: SaveSeasonInput): Promise<Season>;
}

// Outbound port: what Data processing needs.
export interface DataProcessingRepository {
  upsertAttribute(input: AttributeDefinition): Promise<AttributeDefinition>;
  upsertTag(input: TagDefinition): Promise<TagDefinition>;
  upsertSeason(input: Omit<Season, "id">): Promise<Season>;
}
