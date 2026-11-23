import type { SaveLocationInput } from "@magic-events/core/catalogue/ports.ts";

export const HERMANUS_SLUG = "hermanus";

export const hermanus: SaveLocationInput = {
  name: "Hermanus",
  slug: HERMANUS_SLUG,
  country: "South Africa",
  region: "Western Cape",
  timezone: "Africa/Johannesburg",
  latitude: -34.4187,
  longitude: 19.2345,
};
