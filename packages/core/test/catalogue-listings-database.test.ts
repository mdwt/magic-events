import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { events, experience, experienceChange } from "@magic-events/db";
import { count, eq } from "drizzle-orm";
import type { Catalogue, SaveExperienceInput, StoredExperience } from "../src/catalogue/ports.ts";
import { precedenceOf } from "../src/data-processing/match.ts";
import { input } from "../src/testing/catalogue-fake.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// One experience built from three listings against the database: A from the highest-priority source, B and C from
// two sources of the same, lower priority. Each states something the others do not. Once every listing has been
// processed, processing any of them again with unchanged content writes no version, change row or domain event.

let harness: Harness;
let catalogue: Catalogue;
let locationId: string;

const SEASONS = ["whale-season", "winter"];
const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
const priorities: Record<string, number> = { [ids.A]: 10, [ids.B]: 5, [ids.C]: 5 };

// What each listing states, and nothing more.
function listing(name: "A" | "B" | "C"): SaveExperienceInput {
  const bare = input({
    locationId,
    title: "Rumours of Fleetwood Mac",
    summary: undefined,
    description: undefined,
    profile: undefined,
    openingHours: undefined,
    venue: undefined,
    price: undefined,
    onSaleAt: undefined,
    bookingClosesAt: undefined,
    bookingUrl: undefined,
    imageUrl: undefined,
    pageUrl: undefined,
    attributes: {},
    tags: [],
    seasonSlugs: SEASONS,
    source: { listingId: ids[name], rawListingId: randomUUID() },
  });
  if (name === "A") {
    return {
      ...bare,
      venue: { name: "Hermanus Golf Club", city: "Hermanus" },
      price: { min: 250, max: 250, currency: "ZAR" },
      bookingUrl: "https://tickets.example.com/rumours",
      sessions: [{ startDate: "2027-06-12", precision: "day", startTime: "19:00" }],
      attributes: { category: ["music"], scale: ["local"] },
      tags: ["rock-and-pop", "whale-season", "winter"],
    };
  }
  if (name === "B") {
    return {
      ...bare,
      summary: "A tribute to Fleetwood Mac's Rumours.",
      venue: { position: { lat: -34.41, lng: 19.24 } },
      pageUrl: "https://whatson.example.com/rumours",
      sessions: [{ startDate: "2027-06-11", precision: "day" }],
      attributes: { setting: ["indoor"] },
      tags: ["tribute", "winter"],
    };
  }
  return {
    ...bare,
    description: "The album played in full.",
    imageUrl: "https://whatson.example.com/rumours.jpg",
    sessions: [{ startDate: "2027-12-04", precision: "day" }],
    attributes: { audience: ["all_ages"], category: ["performing_arts"] },
    tags: ["classic-rock"],
  };
}

async function stored(): Promise<StoredExperience | undefined> {
  const [row] = await harness.db.select({ id: experience.id }).from(experience).limit(1);
  return row === undefined ? undefined : ((await catalogue.getExperience({ id: row.id })) ?? undefined);
}

// Processes a listing as Data processing does: the first one creates the experience, and each later one leads or
// fills by the priorities of the listings linked to it, the oldest linked first.
async function processListing(name: "A" | "B" | "C"): Promise<void> {
  const one = listing(name);
  const found = await stored();
  if (found === undefined) {
    await catalogue.saveExperience({ ...one, precedence: "lead" });
    return;
  }
  const linked = found.listingIds.map((listingId) => ({ listingId, priority: priorities[listingId] ?? 0 }));
  const own = { listingId: one.source.listingId, priority: priorities[one.source.listingId] ?? 0 };
  await catalogue.saveExperience({ ...one, experienceId: found.id, precedence: precedenceOf(own, linked) });
}

async function written(): Promise<{ changes: number; events: number }> {
  const [changes] = await harness.db.select({ total: count() }).from(experienceChange);
  const [appended] = await harness.db.select({ total: count() }).from(events).where(eq(events.type, "experience.changed"));
  return { changes: changes?.total ?? 0, events: appended?.total ?? 0 };
}

before(async () => {
  harness = await createHarness();
  catalogue = harness.services.catalogue;
});

beforeEach(async () => {
  await harness.db.delete(experience);
  await harness.db.delete(events);
  ({ id: locationId } = await catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  }));
});

after(async () => {
  await harness.close();
});

describe("an experience from three listings of different and equal priorities", () => {
  const orders: ("A" | "B" | "C")[][] = [
    ["A", "B", "C"],
    ["B", "C", "A"],
    ["C", "A", "B"],
    ["C", "B", "A"],
  ];
  for (const order of orders) {
    test(`first processed as ${order.join(", ")}, then again many times, writes nothing new`, async () => {
      for (const name of order) await processListing(name);
      const first = await stored();
      assert.ok(first);
      const before = await written();

      for (const name of ["A", "B", "C", "B", "A", "C", "C", "A"] as const) await processListing(name);
      const again = await stored();
      assert.equal(again?.version, first.version);
      assert.deepEqual(await written(), before);

      // A's values where it states them, B's and C's where it does not.
      assert.deepEqual(again.venue, {
        name: "Hermanus Golf Club",
        address: null,
        city: "Hermanus",
        position: { lat: -34.41, lng: 19.24 },
      });
      assert.deepEqual(again.price, { min: 250, max: 250, currency: "ZAR" });
      assert.equal(again.bookingUrl, "https://tickets.example.com/rumours");
      assert.equal(again.pageUrl, "https://whatson.example.com/rumours");
      assert.equal(again.summary, "A tribute to Fleetwood Mac's Rumours.");
      assert.equal(again.description, "The album played in full.");
      assert.deepEqual(again.attributes, {
        audience: ["all_ages"],
        category: ["music"],
        scale: ["local"],
        setting: ["indoor"],
      });
      assert.deepEqual(again.tags, ["classic-rock", "rock-and-pop", "tribute", "whale-season", "winter"]);
      assert.deepEqual(
        again.sessions.map((session) => session.startDate),
        ["2027-06-12"],
      );
      assert.deepEqual([...again.listingIds].sort(), [ids.A, ids.B, ids.C].sort());
    });
  }
});
