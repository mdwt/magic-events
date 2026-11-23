import type { SaveSeasonInput } from "@magic-events/core/data-processing/ports.ts";
import { HERMANUS_SLUG } from "./location.ts";

// The default seasons of Hermanus, with one dated row per period for 2026, 2027 and 2028.
// A season that crosses the new year, such as summer, is one period from December to February.

export const seasons: SaveSeasonInput[] = [
  {
    locationSlug: HERMANUS_SLUG,
    slug: "whale-season",
    name: "Whale season",
    description:
      "Southern right whales come into Walker Bay to calve and can be watched from the Hermanus cliffs, " +
      "June to November.",
    periods: [
      { startDate: "2026-06-01", endDate: "2026-11-30" },
      { startDate: "2027-06-01", endDate: "2027-11-30" },
      { startDate: "2028-06-01", endDate: "2028-11-30" },
    ],
  },
  {
    locationSlug: HERMANUS_SLUG,
    slug: "south-african-school-holidays",
    name: "South African school holidays",
    description:
      "The holidays between the terms of the public school calendar published by the Department of Basic " +
      "Education, when families travel.",
    // Each period runs from the day after a term ends to the day before the next term starts.
    periods: [
      { startDate: "2026-01-01", endDate: "2026-01-13" },
      { startDate: "2026-03-28", endDate: "2026-04-07" },
      { startDate: "2026-06-27", endDate: "2026-07-20" },
      { startDate: "2026-09-24", endDate: "2026-10-05" },
      { startDate: "2026-12-10", endDate: "2027-01-12" },
      { startDate: "2027-03-20", endDate: "2027-04-05" },
      { startDate: "2027-06-26", endDate: "2027-07-19" },
      { startDate: "2027-09-23", endDate: "2027-10-04" },
      { startDate: "2027-12-09", endDate: "2028-01-11" },
      { startDate: "2028-03-18", endDate: "2028-03-27" },
      { startDate: "2028-06-15", endDate: "2028-07-10" },
      { startDate: "2028-09-23", endDate: "2028-10-02" },
      // The 2029 calendar is not published yet, so the last period ends with the year.
      { startDate: "2028-12-07", endDate: "2028-12-31" },
    ],
  },
  {
    locationSlug: HERMANUS_SLUG,
    slug: "high-season",
    name: "High season",
    description:
      "The peak summer holiday weeks around Christmas and New Year, when Hermanus is at its busiest and " +
      "accommodation books out.",
    periods: [
      { startDate: "2025-12-15", endDate: "2026-01-15" },
      { startDate: "2026-12-15", endDate: "2027-01-15" },
      { startDate: "2027-12-15", endDate: "2028-01-15" },
      { startDate: "2028-12-15", endDate: "2029-01-15" },
    ],
  },
  {
    locationSlug: HERMANUS_SLUG,
    slug: "summer",
    name: "Summer",
    description: "Southern hemisphere summer, December to February: hot, dry and windy, the beach season.",
    periods: [
      { startDate: "2025-12-01", endDate: "2026-02-28" },
      { startDate: "2026-12-01", endDate: "2027-02-28" },
      { startDate: "2027-12-01", endDate: "2028-02-29" },
      { startDate: "2028-12-01", endDate: "2029-02-28" },
    ],
  },
  {
    locationSlug: HERMANUS_SLUG,
    slug: "autumn",
    name: "Autumn",
    description: "Southern hemisphere autumn, March to May: mild, settled days and the wine harvest.",
    periods: [
      { startDate: "2026-03-01", endDate: "2026-05-31" },
      { startDate: "2027-03-01", endDate: "2027-05-31" },
      { startDate: "2028-03-01", endDate: "2028-05-31" },
    ],
  },
  {
    locationSlug: HERMANUS_SLUG,
    slug: "winter",
    name: "Winter",
    description: "Southern hemisphere winter, June to August: cool and rainy, the start of whale season.",
    periods: [
      { startDate: "2026-06-01", endDate: "2026-08-31" },
      { startDate: "2027-06-01", endDate: "2027-08-31" },
      { startDate: "2028-06-01", endDate: "2028-08-31" },
    ],
  },
  {
    locationSlug: HERMANUS_SLUG,
    slug: "spring",
    name: "Spring",
    description:
      "Southern hemisphere spring, September to November: wildflowers, fynbos in bloom and whales in the bay.",
    periods: [
      { startDate: "2026-09-01", endDate: "2026-11-30" },
      { startDate: "2027-09-01", endDate: "2027-11-30" },
      { startDate: "2028-09-01", endDate: "2028-11-30" },
    ],
  },
];
