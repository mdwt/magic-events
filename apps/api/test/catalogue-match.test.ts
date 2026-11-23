import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { experience } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { Catalogue, Location, SaveExperienceInput } from "../src/core/catalogue/ports.ts";
import { input as listing } from "./helpers/catalogue-fake.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";

// Match candidates against the database: same location, a session overlapping the dates, a shared title word.

let harness: Harness;
let catalogue: Catalogue;
let hermanus: Location;
let stanford: Location;
const ids = new Map<string, string>();

function id(name: string): string {
  const found = ids.get(name);
  assert.ok(found, `no experience named ${name}`);
  return found;
}

function day(startDate: string): SaveExperienceInput["sessions"][number] {
  return { startDate, precision: "day" };
}

async function candidates(title: string, from = "2027-09-01", to = "2027-09-30"): Promise<string[]> {
  const found = await catalogue.findMatchCandidates({ locationId: hermanus.id, title, from, to });
  return found.map((one) => one.title);
}

before(async () => {
  harness = await createHarness({ clock: () => new Date("2026-11-23T10:00:00.000Z") });
  catalogue = harness.services.catalogue;
  const place = { country: "ZA", region: "Western Cape", timezone: "Africa/Johannesburg" };
  hermanus = await catalogue.saveLocation({ ...place, name: "Hermanus", slug: "hermanus", latitude: -34.4187, longitude: 19.2345 });
  stanford = await catalogue.saveLocation({ ...place, name: "Stanford", slug: "stanford", latitude: -34.4415, longitude: 19.4584 });

  const experiences: [string, Partial<SaveExperienceInput>][] = [
    ["Hermanus Whale Festival", { type: "single", sessions: [{ startDate: "2027-09-24", endDate: "2027-09-26", precision: "day" }] }],
    ["Whale Festival Kids Fun Run", { sessions: [day("2027-09-25")] }],
    ["Whales of Walker Bay talk", { sessions: [day("2027-09-10")] }],
    ["Whale Festival 2028", { sessions: [day("2028-09-23")] }],
    ["Stanford Whale Festival", { locationId: "stanford", sessions: [day("2027-09-25")] }],
    ["Cancelled Whale Festival", { sessions: [day("2027-09-25")] }],
    ["Past Whale Festival", { sessions: [day("2027-09-25")] }],
    ["Removed Whale Festival", { sessions: [day("2027-09-25")] }],
    ["FynArts", { sessions: [{ startDate: "2027-09-01", precision: "month" }] }],
    ["Hermanus Country Market", {
      type: "recurring",
      booking: "none",
      sessions: [],
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01" },
    }],
  ];
  for (const [title, overrides] of experiences) {
    const locationId = overrides.locationId === "stanford" ? stanford.id : hermanus.id;
    const result = await catalogue.saveExperience(
      listing({ title, ...overrides, locationId, source: { listingId: crypto.randomUUID(), rawListingId: crypto.randomUUID() } }),
    );
    ids.set(title, result.experience.id);
  }
  for (const status of ["cancelled", "past", "removed"] as const) {
    const title = `${status[0]?.toUpperCase() ?? ""}${status.slice(1)} Whale Festival`;
    await harness.db.update(experience).set({ status }).where(eq(experience.id, id(title)));
  }
});

after(async () => {
  await harness.close();
});

describe("findMatchCandidates", () => {
  test("finds experiences sharing a significant title word with a session in the dates, best match first", async () => {
    assert.deepEqual(await candidates("The Whale Festival"), [
      "Hermanus Whale Festival",
      "Whale Festival Kids Fun Run",
      "Whales of Walker Bay talk",
    ]);
  });

  test("matches stemmed words and ignores stop words", async () => {
    assert.deepEqual(await candidates("Festivals of the whales"), [
      "Hermanus Whale Festival",
      "Whale Festival Kids Fun Run",
      "Whales of Walker Bay talk",
    ]);
    assert.deepEqual(await candidates("The of and"), []);
  });

  test("needs a session overlapping the dates", async () => {
    assert.deepEqual(await candidates("Whale Festival", "2027-09-24", "2027-09-24"), ["Hermanus Whale Festival"]);
    assert.deepEqual(await candidates("Whale Festival", "2028-09-01", "2028-09-30"), ["Whale Festival 2028"]);
  });

  test("a month session and generated sessions overlap the dates inside them", async () => {
    assert.deepEqual(await candidates("FynArts festival 2027", "2027-09-15", "2027-09-15"), ["FynArts"]);
    assert.deepEqual(await candidates("Country market", "2027-01-02", "2027-01-02"), ["Hermanus Country Market"]);
  });

  test("leaves out other locations and Cancelled, Removed and Past experiences", async () => {
    const found = await catalogue.findMatchCandidates({
      locationId: stanford.id,
      title: "Whale Festival",
      from: "2027-09-01",
      to: "2027-09-30",
    });
    assert.deepEqual(
      found.map((one) => one.title),
      ["Stanford Whale Festival"],
    );
    const titles = await candidates("Cancelled Past Removed Whale Festival");
    assert.ok(!titles.some((title) => /Cancelled|Past|Removed/.test(title)));
  });

  test("returns what matching needs", async () => {
    const [match] = await catalogue.findMatchCandidates({
      locationId: hermanus.id,
      title: "Hermanus Whale Festival",
      from: "2027-09-01",
      to: "2027-09-30",
    });
    assert.ok(match);
    assert.equal(match.id, id("Hermanus Whale Festival"));
    assert.equal(match.type, "single");
    assert.equal(match.status, "confirmed");
    assert.equal(match.firstDate, "2027-09-24");
    assert.equal(match.lastDate, "2027-09-26");
    assert.deepEqual(match.sessions, [{ startDate: "2027-09-24", endDate: "2027-09-26" }]);
    assert.equal(match.recurrenceRule, null);
    assert.equal(match.listingIds.length, 1);
  });

  test("returns at most ten, and caps a match's sessions at fifty", async () => {
    for (let index = 0; index < 11; index += 1) {
      await catalogue.saveExperience(
        listing({
          locationId: hermanus.id,
          title: `Sunset concert ${index}`,
          sessions: [day("2027-10-02")],
          source: { listingId: crypto.randomUUID(), rawListingId: crypto.randomUUID() },
        }),
      );
    }
    assert.equal((await candidates("Sunset concert", "2027-10-01", "2027-10-31")).length, 10);

    const [market] = await catalogue.findMatchCandidates({
      locationId: hermanus.id,
      title: "Country Market",
      from: "2027-01-01",
      to: "2027-12-31",
    });
    assert.equal(market?.sessions.length, 50);
    assert.equal(market.recurrenceRule, "FREQ=WEEKLY;BYDAY=SA");
    assert.equal(market.firstDate, "2026-11-28");
    assert.equal(market.lastDate, "2028-11-18");
  });
});
