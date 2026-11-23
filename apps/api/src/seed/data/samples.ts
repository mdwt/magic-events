import type { SaveLocationInput } from "../../core/catalogue/ports.ts";
import type { ExperienceFixture } from "../experience-fixture.ts";

// SAMPLE DATA. Made-up experiences for trying search by hand and in tests, seeded only with --samples.
// Real experiences come from discovery and processing. Together they exercise every part of search:
// a recurring market, a month-precision festival, a multi-day single, a run, an exhibition, every status that
// search returns or leaves out, and one experience in Cape Town, well outside the default radius around Hermanus.

// Cape Town is a location only so that the sample outside Hermanus has a location of its own.
export const capeTown: SaveLocationInput = {
  name: "Cape Town",
  slug: "cape-town",
  country: "South Africa",
  region: "Western Cape",
  timezone: "Africa/Johannesburg",
  latitude: -33.9249,
  longitude: 18.4241,
};

// How far ahead the market's Saturday sessions are generated, as Catalogue does for an open-ended recurrence.
const MARKET_HORIZON_MONTHS = 24;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Every Saturday from the given day, inclusive, up to the horizon.
function saturdaysFrom(today: string, months: number): string[] {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + ((6 - day.getUTCDay() + 7) % 7));
  const until = new Date(`${today}T00:00:00Z`);
  until.setUTCMonth(until.getUTCMonth() + months);
  const saturdays: string[] = [];
  while (day <= until) {
    saturdays.push(isoDay(day));
    day.setUTCDate(day.getUTCDate() + 7);
  }
  return saturdays;
}

export function sampleExperiences(input: {
  hermanusId: string;
  capeTownId: string;
  // The seed's run date in Hermanus, as YYYY-MM-DD. The market's sessions start here.
  today: string;
}): (ExperienceFixture & { slug: string })[] {
  const { hermanusId, capeTownId, today } = input;
  const saturdays = saturdaysFrom(today, MARKET_HORIZON_MONTHS);
  const firstSaturday = saturdays[0] ?? today;

  return [
    {
      locationId: hermanusId,
      slug: "sample-hermanus-country-market",
      title: "Hermanus Country Market",
      type: "recurring",
      status: "confirmed",
      booking: "none",
      summary: "The Saturday morning country market, with local produce, crafts and food stalls.",
      profile:
        "A weekly Saturday morning country market in Hermanus with fresh produce, baked goods, crafts and food " +
        "stalls. Browse, shop and have breakfast outdoors among the locals. Relaxed and family friendly, " +
        "suits all ages.",
      openingHours: "Saturdays 09:00 to 13:00",
      venue: { name: "Fernkloof Village Green", city: "Hermanus", lat: -34.4035, lng: 19.2585 },
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: firstSaturday, startTime: "09:00", endTime: "13:00" },
      sessions: saturdays.map((startDate) => ({
        startDate,
        startTime: "09:00",
        endTime: "13:00",
        origin: "generated" as const,
      })),
      attributes: {
        category: ["food_and_drink", "hobbies_and_lifestyle"],
        format: "market",
        audience: "all_ages",
        setting: "outdoor",
        scale: "local",
      },
      tags: ["craft"],
    },
    {
      locationId: hermanusId,
      slug: "sample-hermanus-fynarts-2027",
      title: "Hermanus FynArts 2027",
      type: "single",
      status: "announced",
      booking: "not_yet",
      summary: "The annual winter arts festival: exhibitions, concerts, talks and workshops across Hermanus.",
      profile:
        "An annual winter arts festival held across Hermanus, with art exhibitions, classical and jazz concerts, " +
        "talks by artists and authors, and hands-on workshops. Its days are not announced yet. Cultured and " +
        "unhurried, suits adults and all ages.",
      venue: { name: "Various venues", city: "Hermanus" },
      sessions: [{ startDate: "2027-06-01", precision: "month" }],
      attributes: {
        category: ["visual_arts", "music", "culture_and_heritage"],
        format: "festival",
        audience: "all_ages",
        setting: "indoor",
        scale: "major",
      },
      tags: ["painting", "sculpture", "classical", "jazz", "books"],
    },
    {
      locationId: hermanusId,
      slug: "sample-hermanus-whale-festival-2027",
      title: "Hermanus Whale Festival 2027",
      type: "single",
      status: "confirmed",
      booking: "open",
      summary: "Three days of whale watching, live music, a craft and food market and children's activities.",
      profile:
        "Annual three-day festival on the Hermanus waterfront during whale season. Land-based whale watching, " +
        "live music, a craft and food market, and children's activities. Outdoor and busy, suits families and " +
        "all ages.",
      venue: { name: "Hermanus Old Harbour", city: "Hermanus", lat: -34.4213, lng: 19.2433 },
      price: { min: 0, max: 150, currency: "ZAR" },
      bookingUrl: "https://example.com/whale-festival",
      sessions: [{ startDate: "2027-09-24", endDate: "2027-09-26" }],
      attributes: {
        category: ["nature_and_wildlife", "music", "food_and_drink"],
        format: "festival",
        audience: "family",
        setting: "outdoor",
        scale: "major",
      },
      tags: ["whales", "craft", "seafood"],
    },
    {
      locationId: hermanusId,
      slug: "sample-walker-bay-revue",
      title: "Walker Bay Revue",
      type: "run",
      status: "confirmed",
      booking: "open",
      summary: "An evening of song, sketches and stand-up about life on the Whale Coast.",
      profile:
        "A light-hearted stage revue of songs, sketches and stand-up comedy about life on the Whale Coast, " +
        "performed in English and Afrikaans. An evening out in a small theatre. Suits adults.",
      venue: { name: "Hermanus Village Theatre", city: "Hermanus", lat: -34.4192, lng: 19.2369 },
      price: { min: 180, max: 220, currency: "ZAR" },
      bookingUrl: "https://example.com/walker-bay-revue",
      sessions: ["2027-06-10", "2027-06-11", "2027-06-17", "2027-06-18", "2027-06-24", "2027-06-25"].map(
        (startDate) => ({ startDate, startTime: "19:30", endTime: "21:30" }),
      ),
      attributes: {
        category: ["performing_arts"],
        format: "performance",
        audience: "adults",
        language: ["english", "afrikaans"],
        setting: "indoor",
        scale: "local",
      },
      tags: ["theatre", "comedy", "cabaret"],
    },
    {
      locationId: hermanusId,
      slug: "sample-whales-of-walker-bay-exhibition",
      title: "Whales of Walker Bay: a photographic exhibition",
      type: "single",
      status: "confirmed",
      booking: "none",
      summary: "Large-format photographs of the southern right whales of Walker Bay.",
      profile:
        "A photographic exhibition of the southern right whales of Walker Bay, shown in the town's harbour " +
        "museum over the winter months. Walk through at your own pace. Quiet and indoor, suits all ages.",
      openingHours: "Monday to Saturday 09:00 to 16:30",
      venue: { name: "Old Harbour Museum", city: "Hermanus", lat: -34.4209, lng: 19.2440 },
      sessions: [{ startDate: "2027-05-01", endDate: "2027-08-31" }],
      attributes: {
        category: ["visual_arts", "nature_and_wildlife"],
        format: "exhibition",
        audience: "all_ages",
        setting: "indoor",
        scale: "local",
      },
      tags: ["photography", "whales", "museums"],
    },
    {
      locationId: hermanusId,
      slug: "sample-hemel-en-aarde-jazz-evening",
      title: "Jazz Evening in the Hemel-en-Aarde",
      type: "single",
      status: "confirmed",
      booking: "sold_out",
      summary: "A jazz quartet and a wine pairing at a Hemel-en-Aarde valley estate.",
      profile:
        "An evening concert by a jazz quartet in the cellar of a Hemel-en-Aarde valley wine estate, with a " +
        "pairing of the estate's wines. Intimate and seated. For adults only, no under 18s.",
      venue: { name: "Hemel-en-Aarde Estate Cellar", city: "Hermanus", lat: -34.3906, lng: 19.2618 },
      price: { min: 450, max: 450, currency: "ZAR" },
      bookingUrl: "https://example.com/jazz-evening",
      sessions: [{ startDate: "2027-06-19", startTime: "18:30", endTime: "22:00", soldOut: true }],
      attributes: {
        category: ["music", "food_and_drink"],
        format: "performance",
        audience: "adults",
        minimum_age: 18,
        setting: "indoor",
        scale: "regional",
      },
      tags: ["jazz", "wine"],
    },
    {
      locationId: hermanusId,
      slug: "sample-overstrand-choir-festival",
      title: "Overstrand Choir Festival",
      type: "single",
      status: "postponed",
      booking: "closed",
      summary: "School and community choirs from across the Overstrand. Postponed; a new date is to follow.",
      profile:
        "A choir festival bringing together school and community choirs from across the Overstrand for an " +
        "afternoon of choral and gospel music. Postponed, with no new date yet. Suits families and all ages.",
      venue: { name: "Hermanus Civic Hall", city: "Hermanus", lat: -34.4183, lng: 19.2351 },
      sessions: [{ startDate: "2027-06-12", startTime: "14:00", endTime: "17:00" }],
      attributes: {
        category: ["music", "community_and_causes"],
        format: "performance",
        audience: "all_ages",
        setting: "indoor",
        scale: "local",
      },
      tags: ["choral", "gospel"],
    },
    {
      locationId: hermanusId,
      slug: "sample-whale-coast-food-and-wine-fair",
      title: "Whale Coast Food and Wine Fair",
      type: "single",
      status: "cancelled",
      booking: "closed",
      summary: "A day of tastings from Overstrand wine farms and producers. Cancelled by the organisers.",
      profile:
        "A one-day fair of wine, gin and food tastings from Overstrand farms and producers. Cancelled by its " +
        "organisers. Sociable and outdoor, suits adults.",
      venue: { name: "Hermanus Sports Grounds", city: "Hermanus", lat: -34.4150, lng: 19.2470 },
      sessions: [{ startDate: "2027-06-05", startTime: "10:00", endTime: "17:00", status: "cancelled" }],
      attributes: {
        category: ["food_and_drink"],
        format: "fair_or_expo",
        audience: "adults",
        setting: "outdoor",
        scale: "regional",
      },
      tags: ["wine", "gin"],
    },
    {
      locationId: hermanusId,
      slug: "sample-carols-by-candlelight-2025",
      title: "Carols by Candlelight 2025",
      type: "single",
      status: "past",
      booking: "none",
      summary: "Christmas carols on the cliffs at sunset.",
      profile:
        "An evening of Christmas carols sung by candlelight on the Hermanus cliffs at sunset. Bring a blanket " +
        "and join in. Festive and outdoor, suits families and all ages.",
      venue: { name: "Gearing's Point", city: "Hermanus", lat: -34.4224, lng: 19.2457 },
      sessions: [{ startDate: "2025-12-20", startTime: "19:00", endTime: "21:00" }],
      attributes: {
        category: ["holidays_and_celebrations", "faith_and_spirituality", "music"],
        format: "parade_or_ceremony",
        audience: "family",
        setting: "outdoor",
        scale: "local",
      },
      tags: ["christmas", "choral"],
    },
    {
      locationId: capeTownId,
      slug: "sample-cape-town-winter-symphony",
      title: "Winter Symphony at the City Hall",
      type: "single",
      status: "confirmed",
      booking: "open",
      summary: "An orchestral evening of Romantic symphonies in Cape Town's City Hall.",
      profile:
        "An orchestral concert of Romantic symphonies in the grand hall of Cape Town's City Hall. A formal " +
        "evening of classical music. Suits adults and older children.",
      venue: { name: "Cape Town City Hall", city: "Cape Town", lat: -33.9255, lng: 18.4236 },
      price: { min: 200, max: 480, currency: "ZAR" },
      bookingUrl: "https://example.com/winter-symphony",
      sessions: [{ startDate: "2027-06-17", startTime: "20:00", endTime: "22:00" }],
      attributes: {
        category: ["music"],
        format: "performance",
        audience: "all_ages",
        setting: "indoor",
        scale: "regional",
      },
      tags: ["classical"],
    },
  ];
}
