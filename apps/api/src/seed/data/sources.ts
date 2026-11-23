import type { SaveSourceInput } from "../../core/discovery/ports.ts";
import { HERMANUS_SLUG } from "./location.ts";

// The Hermanus sources from docs/discovery.md that the docs give enough to fetch. The PDF calendars and web pages
// need page addresses the docs do not give, so they are left out.
// Ticketing APIs give structured data and rank above the news feed when sources disagree. Their adapters are not
// built yet, so the two rows are inactive until they are.

export const sources: SaveSourceInput[] = [
  {
    name: "Quicket",
    kind: "quicket",
    locationSlug: HERMANUS_SLUG,
    credentialsSetting: "QUICKET_API_KEY",
    priority: 20,
    active: false,
  },
  {
    name: "Ticketmaster",
    kind: "ticketmaster",
    locationSlug: HERMANUS_SLUG,
    credentialsSetting: "TICKETMASTER_API_KEY",
    priority: 20,
    active: false,
  },
  {
    name: "Hermanus Times",
    kind: "rss_feed",
    locationSlug: HERMANUS_SLUG,
    settings: { feedUrl: "https://novanews.co.za/hermanustimes/feed/" },
    priority: 10,
  },
];
