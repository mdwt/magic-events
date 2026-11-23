import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { experience } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { Catalogue, SearchExperiencesInput, SearchExperiencesResult } from "../src/catalogue/ports.ts";
import { AppError } from "../src/shared/errors.ts";
import { attributes } from "../src/data-processing/default-attributes.ts";
import { insertExperienceFixture, type ExperienceFixture } from "../src/testing/experience-fixture.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Search against the database. The stay is 10 to 20 June 2027 in Hermanus, as in UC1.

const HERMANUS = { lat: -34.4187, lng: 19.2345 };

let harness: Harness;
let catalogue: Catalogue;
const ids = new Map<string, string>();

function id(name: string): string {
  const found = ids.get(name);
  assert.ok(found, `no fixture named ${name}`);
  return found;
}

function search(input: Partial<SearchExperiencesInput> = {}): Promise<SearchExperiencesResult> {
  return catalogue.searchExperiences({ near: HERMANUS, from: "2027-06-10", to: "2027-06-20", limit: 20, offset: 0, ...input });
}

async function found(input: Partial<SearchExperiencesInput> = {}): Promise<string[]> {
  const result = await search(input);
  return result.items.map((item) => item.title);
}

const thursdays = ["2027-06-03", "2027-06-10", "2027-06-17", "2027-06-24"];
const saturdays = ["2027-06-05", "2027-06-12", "2027-06-19", "2027-06-26"];

before(async () => {
  harness = await createHarness();
  catalogue = harness.services.catalogue;
  // The default attribute definitions, which a search's filters are checked against.
  for (const definition of attributes) await harness.services.dataProcessing.saveAttribute(definition);
  const hermanus = await catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: HERMANUS.lat,
    longitude: HERMANUS.lng,
  });
  const stellenbosch = await catalogue.saveLocation({
    name: "Stellenbosch",
    slug: "stellenbosch",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -33.9321,
    longitude: 18.8602,
  });

  const fixtures: Omit<ExperienceFixture, "locationId">[] = [
    {
      title: "Hermanus Whale Festival",
      status: "confirmed",
      booking: "open",
      bookingUrl: "https://tickets.example.com/whale-festival",
      venue: { name: "Waterfront", lat: -34.421, lng: 19.244 },
      profile: "Three-day festival on the waterfront in whale season, with whale watching and live music.",
      sessions: [{ startDate: "2027-06-08", endDate: "2027-06-10" }],
      attributes: { category: ["nature_and_wildlife", "music"], audience: "family" },
      tags: ["whales", "festival"],
    },
    {
      title: "Thursday Theatre",
      type: "run",
      status: "announced",
      booking: "not_yet",
      venue: { name: "Municipal Auditorium", lat: -34.415, lng: 19.24 },
      sessions: thursdays.map((startDate) => ({ startDate, startTime: "19:30" })),
      attributes: { category: ["performing_arts"], minimum_age: 16 },
      tags: ["theatre"],
    },
    {
      title: "FynArts",
      status: "expected",
      profile: "An art festival with exhibitions, talks and jazz across the town.",
      sessions: [{ startDate: "2027-06-01", precision: "month" }],
      attributes: { category: ["visual_arts", "music"] },
      tags: ["painting"],
    },
    {
      title: "Gansbaai Shark Cage Diving",
      status: "confirmed",
      booking: "sold_out",
      venue: { name: "Kleinbaai harbour", lat: -34.5806, lng: 19.3494 },
      sessions: [{ startDate: "2027-06-15" }],
      attributes: { category: ["nature_and_wildlife"], minimum_age: 12, wheelchair_accessible: false },
      tags: ["sharks"],
    },
    {
      title: "Cape Town Jazz Night",
      booking: "open",
      venue: { name: "Cape Town club", lat: -33.9249, lng: 18.4241 },
      sessions: [{ startDate: "2027-06-12" }],
      tags: ["jazz"],
    },
    { title: "Cancelled Concert", status: "cancelled", sessions: [{ startDate: "2027-06-12" }] },
    { title: "Removed Market", status: "removed", sessions: [{ startDate: "2027-06-12" }] },
    { title: "Past Exhibition", status: "past", sessions: [{ startDate: "2027-06-01", endDate: "2027-06-30" }] },
    {
      title: "Cancelled Night",
      sessions: [{ startDate: "2027-06-12", status: "cancelled" }, { startDate: "2027-06-25" }],
    },
    {
      title: "Postponed Regatta",
      status: "postponed",
      sessions: [{ startDate: "2027-06-14" }],
      attributes: { category: ["sport"] },
      tags: ["sailing"],
    },
    {
      title: "Hermanus Country Market",
      type: "recurring",
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2027-06-05", startTime: "09:00", endTime: "13:00" },
      sessions: saturdays.map((startDate) => ({ startDate, startTime: "09:00", endTime: "13:00", origin: "generated" as const })),
      attributes: { category: ["food_and_drink"], audience: "all_ages", wheelchair_accessible: true },
      tags: ["craft"],
    },
  ];
  for (const fixture of fixtures) {
    ids.set(fixture.title, await insertExperienceFixture(harness.db, { locationId: hermanus.id, ...fixture }));
  }
  ids.set(
    "Stellenbosch Wine Harvest",
    await insertExperienceFixture(harness.db, {
      locationId: stellenbosch.id,
      title: "Stellenbosch Wine Harvest",
      sessions: [{ startDate: "2027-06-13" }],
      tags: ["wine"],
    }),
  );
});

after(async () => {
  await harness.close();
});

// What the stay finds by default, in date order of the first matching session.
const IN_RANGE = [
  "FynArts",
  "Hermanus Whale Festival",
  "Thursday Theatre",
  "Hermanus Country Market",
  "Postponed Regatta",
  "Gansbaai Shark Cage Diving",
];

describe("search by place", () => {
  test("returns what is within the default radius, in date order", async () => {
    const result = await search();
    assert.deepEqual(
      result.items.map((item) => item.title),
      IN_RANGE,
    );
    assert.equal(result.total, IN_RANGE.length);
  });

  test("leaves out what is beyond the radius", async () => {
    const titles = await found({ radiusKm: 15 });
    assert.ok(!titles.includes("Gansbaai Shark Cage Diving"));
    assert.ok(titles.includes("Hermanus Whale Festival"));
  });

  test("uses the location's centre for an experience with no position of its own", async () => {
    const fynarts = (await search()).items.find((item) => item.title === "FynArts");
    assert.equal(fynarts?.venue.position, null);
    assert.equal(fynarts.distanceKm, 0);

    const wider = await search({ radiusKm: 70 });
    const harvest = wider.items.find((item) => item.title === "Stellenbosch Wine Harvest");
    assert.ok(harvest, "the Stellenbosch experience is within 70 km by its location's centre");
    assert.equal(harvest.venue.position, null);
    assert.ok(harvest.distanceKm > 60 && harvest.distanceKm < 70, `distance ${harvest.distanceKm}`);
    assert.ok(!wider.items.some((item) => item.title === "Cape Town Jazz Night"));
    assert.ok(!(await found()).includes("Stellenbosch Wine Harvest"));
  });

  test("works out the distance from the experience's own position", async () => {
    const result = await search({ radiusKm: 100 });
    const shark = result.items.find((item) => item.title === "Gansbaai Shark Cage Diving");
    assert.ok(shark);
    assert.deepEqual(shark.venue.position, { lat: -34.5806, lng: 19.3494 });
    assert.ok(shark.distanceKm > 19 && shark.distanceKm < 23, `distance ${shark.distanceKm}`);
    assert.equal(shark.distanceKm, Math.round(shark.distanceKm * 10) / 10);
    assert.ok(result.items.some((item) => item.title === "Cape Town Jazz Night"));
  });

  test("a location's slug searches around its centre, with the default radius", async () => {
    const result = await search({ near: undefined, location: "hermanus" });
    assert.deepEqual(
      result.items.map((item) => item.title),
      IN_RANGE,
    );
    const wider = await found({ near: undefined, location: "hermanus", radiusKm: 70 });
    assert.ok(wider.includes("Stellenbosch Wine Harvest"));
    await assert.rejects(
      search({ near: undefined, location: "atlantis" }),
      (error: unknown) => error instanceof AppError && error.code === "invalid_input",
    );
  });

  test("finds what is at the search point itself, without a rounding error", async () => {
    const titles = await found({ near: { lat: -34.421, lng: 19.244 }, radiusKm: 0.001 });
    assert.deepEqual(titles, ["Hermanus Whale Festival"]);
  });
});

describe("search by dates", () => {
  test("a show that is on only on Thursdays is not returned for a Tuesday", async () => {
    assert.ok(!(await found({ from: "2027-06-15", to: "2027-06-15" })).includes("Thursday Theatre"));
    const thursday = await search({ from: "2027-06-17", to: "2027-06-17" });
    const show = thursday.items.find((item) => item.title === "Thursday Theatre");
    assert.deepEqual(
      show?.sessions.map((session) => session.startDate),
      ["2027-06-17"],
    );
  });

  test("a three-day session matches when it overlaps the edge of the range", async () => {
    const result = await search({ from: "2027-06-10", to: "2027-06-20" });
    const festival = result.items.find((item) => item.title === "Hermanus Whale Festival");
    assert.deepEqual(
      festival?.sessions.map((session) => [session.startDate, session.endDate]),
      [["2027-06-08", "2027-06-10"]],
    );
    assert.ok((await found({ from: "2027-06-01", to: "2027-06-08" })).includes("Hermanus Whale Festival"));
    assert.ok(!(await found({ from: "2027-06-11", to: "2027-06-20" })).includes("Hermanus Whale Festival"));
  });

  test("a month-precision session matches any dates inside its month and says so", async () => {
    const result = await search({ from: "2027-06-21", to: "2027-06-22" });
    const fynarts = result.items.find((item) => item.title === "FynArts");
    assert.deepEqual(fynarts?.sessions, [
      {
        startDate: "2027-06-01",
        endDate: "2027-06-30",
        precision: "month",
        startTime: null,
        endTime: null,
        label: null,
        soldOut: false,
      },
    ]);
    assert.ok(!(await found({ from: "2027-07-01", to: "2027-07-05" })).includes("FynArts"));
  });

  test("a cancelled session does not match", async () => {
    assert.ok(!(await found()).includes("Cancelled Night"));
    const later = await search({ from: "2027-06-21", to: "2027-06-30" });
    const night = later.items.find((item) => item.title === "Cancelled Night");
    assert.deepEqual(
      night?.sessions.map((session) => session.startDate),
      ["2027-06-25"],
    );
  });

  test("returns exactly the sessions inside the range, in date order", async () => {
    const result = await search();
    const sessions = (title: string) =>
      result.items.find((item) => item.title === title)?.sessions.map((session) => session.startDate);
    assert.deepEqual(sessions("Thursday Theatre"), ["2027-06-10", "2027-06-17"]);
    assert.deepEqual(sessions("Hermanus Country Market"), ["2027-06-12", "2027-06-19"]);
    const market = result.items.find((item) => item.title === "Hermanus Country Market");
    assert.equal(market?.sessions[0]?.startTime, "09:00:00");
  });
});

describe("search by status and booking", () => {
  test("never returns Cancelled, Removed or Past experiences", async () => {
    const titles = await found({ from: "2027-06-01", to: "2027-06-30", radiusKm: 200, limit: 100 });
    for (const title of ["Cancelled Concert", "Removed Market", "Past Exhibition"]) {
      assert.ok(!titles.includes(title), `${title} was returned`);
    }
  });

  test("filters by status", async () => {
    assert.deepEqual(await found({ status: ["postponed"] }), ["Postponed Regatta"]);
    assert.deepEqual(await found({ status: ["expected", "announced"] }), ["FynArts", "Thursday Theatre"]);
  });

  test("bookable returns only Confirmed with booking Open and a link to book through", async () => {
    assert.deepEqual(await found({ bookable: true }), ["Hermanus Whale Festival"]);
    // The jazz night is Confirmed with booking Open, but has no booking link and no page of its own.
    assert.deepEqual(await found({ bookable: true, radiusKm: 100 }), ["Hermanus Whale Festival"]);
    assert.deepEqual(await found({ bookable: true, status: ["announced"] }), []);
  });

  test("its own page is a link to book through when it has no booking link", async () => {
    await harness.db
      .update(experience)
      .set({ pageUrl: "https://whatson.example.com/jazz-night" })
      .where(eq(experience.title, "Cape Town Jazz Night"));
    try {
      assert.deepEqual(await found({ bookable: true, radiusKm: 100 }), [
        "Hermanus Whale Festival",
        "Cape Town Jazz Night",
      ]);
      const result = await search({ radiusKm: 100 });
      assert.equal(result.items.find((item) => item.title === "Cape Town Jazz Night")?.bookable, true);
    } finally {
      await harness.db.update(experience).set({ pageUrl: null }).where(eq(experience.title, "Cape Town Jazz Night"));
    }
  });

  test("marks each result bookable or not, as the bookable filter selects", async () => {
    const result = await search({ radiusKm: 100 });
    const bookable = Object.fromEntries(result.items.map((item) => [item.title, item.bookable]));
    assert.equal(bookable["Hermanus Whale Festival"], true);
    assert.equal(bookable["Cape Town Jazz Night"], false);
    assert.equal(bookable["Gansbaai Shark Cage Diving"], false);
    assert.equal(bookable["Thursday Theatre"], false);
  });
});

describe("search by attributes and tags", () => {
  test("a list matches any of its values", async () => {
    assert.deepEqual(await found({ attributes: { category: ["visual_arts", "performing_arts"] } }), [
      "FynArts",
      "Thursday Theatre",
    ]);
  });

  test("every attribute given must match", async () => {
    assert.deepEqual(await found({ attributes: { category: "music", audience: "family" } }), [
      "Hermanus Whale Festival",
    ]);
  });

  test("a boolean equals", async () => {
    assert.deepEqual(await found({ attributes: { wheelchair_accessible: true } }), ["Hermanus Country Market"]);
    assert.deepEqual(await found({ attributes: { wheelchair_accessible: false } }), ["Gansbaai Shark Cage Diving"]);
  });

  test("a number equals, and a range compares numbers", async () => {
    assert.deepEqual(await found({ attributes: { minimum_age: 12 } }), ["Gansbaai Shark Cage Diving"]);
    assert.deepEqual(await found({ attributes: { minimum_age: { min: 14 } } }), ["Thursday Theatre"]);
    assert.deepEqual(await found({ attributes: { minimum_age: { min: 10, max: 20 } } }), [
      "Thursday Theatre",
      "Gansbaai Shark Cage Diving",
    ]);
  });

  test("a range with only a max also finds the experiences that have no value", async () => {
    // Suitable for a 14-year-old: the dive from 12, and everything with no minimum age. Not the theatre, from 16.
    assert.deepEqual(
      await found({ attributes: { minimum_age: { max: 14 } } }),
      IN_RANGE.filter((title) => title !== "Thursday Theatre"),
    );
    // A range with a min matches a recorded value only.
    assert.deepEqual(await found({ attributes: { minimum_age: { min: 0 } } }), [
      "Thursday Theatre",
      "Gansbaai Shark Cage Diving",
    ]);
  });

  test("a filter that fits no attribute definition is refused, with what can be used", async () => {
    const refused = (input: Partial<SearchExperiencesInput>) =>
      assert.rejects(search(input), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "invalid_input");
        return true;
      });
    await refused({ attributes: { colour: "blue" } });
    await refused({ attributes: { category: "no_such_category" } });
    await refused({ attributes: { audience: { min: 0 } } });

    const error = await search({ attributes: { colour: "blue" } }).catch((caught: unknown) => caught);
    assert.ok(error instanceof AppError);
    assert.match(error.message, /There is no attribute colour\. The attributes to filter on are: .*category.*minimum_age/);
  });

  test("tags match any of the given slugs", async () => {
    assert.deepEqual(await found({ tags: ["whales", "sharks"] }), [
      "Hermanus Whale Festival",
      "Gansbaai Shark Cage Diving",
    ]);
    assert.deepEqual(await found({ tags: ["nothing-like-this"] }), []);
  });

  test("returns attributes grouped by key and tags in a stable order", async () => {
    const festival = (await search()).items.find((item) => item.title === "Hermanus Whale Festival");
    assert.deepEqual(festival?.attributes, { audience: ["family"], category: ["music", "nature_and_wildlife"] });
    assert.deepEqual(festival.tags, ["festival", "whales"]);
    assert.deepEqual(festival.location, { slug: "hermanus", name: "Hermanus" });
    assert.equal(festival.id, id("Hermanus Whale Festival"));
  });
});

describe("search with a query text", () => {
  test("orders by keyword first and never changes the set", async () => {
    const result = await search({ query: "art exhibitions" });
    assert.equal(result.items[0]?.title, "FynArts");
    assert.deepEqual(result.items.map((item) => item.title).sort(), [...IN_RANGE].sort());
    assert.equal(result.total, IN_RANGE.length);

    const whales = await search({ query: "whale watching" });
    assert.equal(whales.items[0]?.title, "Hermanus Whale Festival");
    assert.deepEqual(whales.items.map((item) => item.title).sort(), [...IN_RANGE].sort());
  });

  test("words that match nothing leave the date order", async () => {
    assert.deepEqual(await found({ query: "zzyzx" }), IN_RANGE);
    assert.deepEqual(await found({ query: "the" }), IN_RANGE);
  });
});

describe("paging", () => {
  test("applies limit and offset after ordering, and counts every match", async () => {
    const first = await search({ limit: 2, offset: 0 });
    assert.deepEqual(
      first.items.map((item) => item.title),
      IN_RANGE.slice(0, 2),
    );
    assert.deepEqual([first.total, first.limit, first.offset], [IN_RANGE.length, 2, 0]);

    const second = await search({ limit: 2, offset: 2 });
    assert.deepEqual(
      second.items.map((item) => item.title),
      IN_RANGE.slice(2, 4),
    );

    const beyond = await search({ limit: 2, offset: 50 });
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.total, IN_RANGE.length);
  });
});

describe("locations", () => {
  test("saving a location again by its slug updates it", async () => {
    const before = await catalogue.getLocation({ slug: "stellenbosch" });
    assert.ok(before);
    const saved = await catalogue.saveLocation({
      name: "Stellenbosch",
      slug: "stellenbosch",
      country: "ZA",
      region: "Cape Winelands",
      timezone: "Africa/Johannesburg",
      latitude: before.latitude,
      longitude: before.longitude,
    });
    assert.equal(saved.id, before.id);
    assert.equal(saved.region, "Cape Winelands");
    assert.deepEqual(await catalogue.getLocation({ id: before.id }), saved);
    assert.equal(await catalogue.getLocation({ slug: "nowhere" }), null);
  });
});
