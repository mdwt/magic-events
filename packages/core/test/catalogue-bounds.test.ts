import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Catalogue, SearchExperiencesInput } from "../src/catalogue/ports.ts";
import { insertExperienceFixture } from "../src/testing/experience-fixture.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Search narrows to the latitudes and longitudes a radius can reach before it works out the exact distance, so an
// index can serve the place. These are the places where those bounds are easy to get wrong: across the 180th
// meridian, near a pole, and at the edge of the circle, where its longitude is furthest from the point's.

const EARTH_RADIUS_KM = 6371.0088;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;

let harness: Harness;
let catalogue: Catalogue;

async function found(input: Partial<SearchExperiencesInput>): Promise<string[]> {
  const result = await catalogue.searchExperiences({ from: "2027-06-10", to: "2027-06-20", limit: 100, offset: 0, ...input });
  return result.items.map((item) => item.title).sort();
}

// The point on the circle of the radius around the point given whose longitude is furthest from it.
function furthestLongitude(near: { lat: number; lng: number }, radiusKm: number): { lat: number; lng: number } {
  const angle = radiusKm / EARTH_RADIUS_KM;
  return {
    lat: degrees(Math.asin(Math.sin(radians(near.lat)) / Math.cos(angle))),
    lng: near.lng + degrees(Math.asin(Math.sin(angle) / Math.cos(radians(near.lat)))),
  };
}

const TAVEUNI = { lat: -16.85, lng: 179.98 };
const NORTH = { lat: 89.95, lng: 0 };
const OSLO = { lat: 59.9139, lng: 10.7522 };

before(async () => {
  harness = await createHarness();
  catalogue = harness.services.catalogue;
  const location = (slug: string, point: { lat: number; lng: number }) =>
    catalogue.saveLocation({
      name: slug,
      slug,
      country: "XX",
      region: "Test",
      timezone: "UTC",
      latitude: point.lat,
      longitude: point.lng,
    });
  const taveuni = await location("taveuni", TAVEUNI);
  const north = await location("north", NORTH);
  const oslo = await location("oslo", OSLO);
  // Across the 180th meridian from the location, and the location's centre itself.
  const add = (locationId: string, title: string, venue?: { lat: number; lng: number }) =>
    insertExperienceFixture(harness.db, {
      locationId,
      title,
      ...(venue === undefined ? {} : { venue: { name: title, ...venue } }),
      sessions: [{ startDate: "2027-06-12" }],
    });
  await add(taveuni.id, "West of the meridian", { lat: -16.84, lng: -179.97 });
  await add(taveuni.id, "East of the meridian", { lat: -16.86, lng: 179.9 });
  await add(taveuni.id, "Taveuni centre");
  // Over the pole from the location: the other side of the world by longitude, 11 km away.
  await add(north.id, "Over the pole", { lat: 89.95, lng: 180 });
  // On the circle of 49.9 km around Oslo, where its longitude is furthest out, so inside a 50 km search.
  await add(oslo.id, "Edge of the circle", furthestLongitude(OSLO, 49.9));
  await add(oslo.id, "Just beyond the circle", furthestLongitude(OSLO, 50.1));
});

after(async () => {
  await harness.close();
});

describe("search by place, at the edges of the bounds", () => {
  test("finds what is across the 180th meridian, from either side", async () => {
    const all = ["East of the meridian", "Taveuni centre", "West of the meridian"];
    assert.deepEqual(await found({ near: { lat: -16.85, lng: 179.99 }, radiusKm: 30 }), all);
    assert.deepEqual(await found({ near: { lat: -16.85, lng: -179.99 }, radiusKm: 30 }), all);
    assert.deepEqual(await found({ location: "taveuni", radiusKm: 30 }), all);
  });

  test("finds what is over the pole, at any longitude", async () => {
    assert.deepEqual(await found({ location: "north", radiusKm: 20 }), ["Over the pole"]);
    assert.deepEqual(await found({ near: { lat: 89.95, lng: 90 }, radiusKm: 20 }), ["Over the pole"]);
  });

  test("keeps what is at the edge of the circle, where its longitude is furthest out, and nothing beyond", async () => {
    assert.deepEqual(await found({ near: OSLO, radiusKm: 50 }), ["Edge of the circle"]);
    assert.deepEqual(await found({ near: OSLO, radiusKm: 50.2 }), ["Edge of the circle", "Just beyond the circle"]);
  });
});
