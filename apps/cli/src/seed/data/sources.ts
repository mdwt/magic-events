import type { SaveSourceInput } from "@magic-events/core/discovery/ports.ts";
import { HERMANUS_SLUG } from "./location.ts";

// The Hermanus sources. Every address was fetched and checked on 23 Nov 2026 (docs/hermanus-sources.md).
//
// Priority says whose word counts when sources disagree about the same experience:
//   30  the organiser's own site
//   20  a ticket seller
//   15  the municipality's and the tourism office's calendars
//   10  a regional listing, the local paper
//    5  an aggregator that copies from the others

export const sources: SaveSourceInput[] = [
  {
    // The festival's own site: its event list is the page of each of its own events.
    name: "Hermanus FynArts",
    kind: "web_page",
    locationSlug: HERMANUS_SLUG,
    settings: { urls: ["https://www.hermanusfynarts.co.za/event-list"], ownPages: true },
    priority: 30,
  },
  {
    // The site's own events feed. It lists nothing until the next festival's programme is published. A feed is
    // not a page a person opens, so it is not the festival's page address.
    name: "Hermanus Whale Festival",
    kind: "web_page",
    locationSlug: HERMANUS_SLUG,
    settings: { urls: ["https://hermanuswhalefestival.co.za/wp-json/tribe/events/v1/events"] },
    priority: 30,
  },
  {
    // Quicket's public search pages need no key. The events are in the pages' structured data.
    name: "Quicket public pages",
    kind: "web_page",
    locationSlug: HERMANUS_SLUG,
    settings: {
      urls: [
        "https://www.quicket.co.za/events/south-africa?search=hermanus",
        "https://www.quicket.co.za/events/south-africa/2/?search=hermanus",
        "https://www.quicket.co.za/events/south-africa?search=stanford",
      ],
    },
    priority: 20,
  },
  {
    name: "Overstrand weekly diary",
    kind: "web_page",
    locationSlug: HERMANUS_SLUG,
    settings: { urls: ["https://www.overstrand.gov.za/top-things-to-do-this-weekend/"] },
    priority: 15,
  },
  {
    name: "Whale Coast annual events calendar",
    kind: "pdf_calendar",
    locationSlug: HERMANUS_SLUG,
    settings: { pageUrl: "https://whalecoast.info/events-calendar/", calendarName: "Annual events" },
    priority: 15,
  },
  {
    name: "Whale Coast monthly events calendar",
    kind: "pdf_calendar",
    locationSlug: HERMANUS_SLUG,
    settings: { pageUrl: "https://whalecoast.info/events-calendar/", calendarName: "Monthly events" },
    priority: 15,
  },
  {
    name: "Wesgro Cape Overberg events",
    kind: "web_page",
    locationSlug: HERMANUS_SLUG,
    settings: { urls: ["https://www.wesgro.co.za/travel/events?category=416162"] },
    priority: 10,
  },
  {
    name: "Hermanus Times",
    kind: "rss_feed",
    locationSlug: HERMANUS_SLUG,
    settings: { feedUrl: "https://novanews.co.za/hermanustimes/feed/" },
    priority: 10,
  },
  {
    name: "AllEvents.in Hermanus",
    kind: "web_page",
    locationSlug: HERMANUS_SLUG,
    settings: { urls: ["https://allevents.in/hermanus/all"] },
    priority: 5,
  },
  {
    name: "Xplorio Hermanus",
    kind: "web_page",
    locationSlug: HERMANUS_SLUG,
    settings: { urls: ["https://xplorio.com/hermanus/en/things-to-do/events/"] },
    priority: 5,
  },
  {
    // The two sources with an API. Their adapters are not built, so the rows are inactive.
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
];
