import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
  experienceChangesInputSchema,
  experienceChangesResultSchema,
  type Catalogue,
  type ExperienceChangesInput,
  type SaveExperienceInput,
} from "../src/catalogue/ports.ts";
import { attributes } from "../src/data-processing/default-attributes.ts";
import { input as listing } from "../src/testing/catalogue-fake.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// UC2 against the database: a travel agent searched on 2 December 2026 for a trip to Hermanus from 10 to 20 June
// 2027, and checks back on 31 December. Every change is made the way the pipeline makes it, through saveExperience,
// removeSourceLink and the upkeep, each on its own day.

const START = Date.UTC(2026, 11, 1, 10);
const DAY = 86_400_000;
const at = (day: number) => new Date(START + day * DAY);
const clock = { now: at(0) };

const HERMANUS = { lat: -34.4187, lng: 19.2345 };
const SINCE = at(1).toISOString();

let harness: Harness;
let catalogue: Catalogue;
let locationId: string;
// Each experience's listing as last saved, and its ID, by a short name.
const saved = new Map<string, { input: SaveExperienceInput; id: string }>();

function changes(overrides: Partial<ExperienceChangesInput> = {}) {
  return catalogue.getChangesSince(
    experienceChangesInputSchema.parse({ near: HERMANUS, from: "2027-06-10", to: "2027-06-20", since: SINCE, ...overrides }),
  );
}

function names(result: { items: { experience: { id: string } }[] }): string[] {
  const byId = new Map([...saved].map(([name, one]) => [one.id, name]));
  return result.items.map((item) => byId.get(item.experience.id) ?? item.experience.id);
}

async function create(name: string, day: number, overrides: Partial<SaveExperienceInput> = {}) {
  clock.now = at(day);
  const input = listing({
    locationId,
    title: `Experience ${name}`,
    bookingClosesAt: undefined,
    sessions: [{ startDate: "2027-06-12", precision: "day", startTime: "18:00", endTime: "22:00" }],
    source: { listingId: randomUUID(), rawListingId: randomUUID() },
    ...overrides,
  });
  const result = await catalogue.saveExperience(input);
  saved.set(name, { input, id: result.experience.id });
}

// Saves the experience's listing again on the day, with the changes, as a new raw listing of the same listing.
async function update(name: string, day: number, overrides: Partial<SaveExperienceInput>) {
  const one = saved.get(name);
  assert.ok(one, name);
  clock.now = at(day);
  const input: SaveExperienceInput = {
    ...one.input,
    ...overrides,
    experienceId: one.id,
    source: { listingId: one.input.source.listingId, rawListingId: randomUUID() },
  };
  const result = await catalogue.saveExperience(input);
  assert.equal(result.changed, true, `${name} changed`);
  saved.set(name, { input, id: one.id });
}

const price = { min: 200, max: 400, currency: "ZAR" };

before(async () => {
  harness = await createHarness({ clock: () => clock.now });
  catalogue = harness.services.catalogue;
  // The default attribute definitions, which a filter is checked against.
  for (const definition of attributes) await harness.services.dataProcessing.saveAttribute(definition);
  ({ id: locationId } = await catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: HERMANUS.lat,
    longitude: HERMANUS.lng,
  }));

  // Before the agent's search.
  await create("unchanged", 0);
  await create("confirmed", 0, { status: "announced", booking: "not_yet" });
  for (const name of ["rescheduled", "postponed", "cancelled", "removed", "price", "before"]) await create(name, 0);
  await create("far", 0, { venue: { name: "City Hall", city: "Cape Town", position: { lat: -33.9249, lng: 18.4241 } } });
  for (const name of ["december", "december cancelled"]) {
    await create(name, 0, { sessions: [{ startDate: "2027-12-04", precision: "day" }] });
  }
  await create("over", 0, { sessions: [{ startDate: "2026-12-10", precision: "day" }] });
  await create("this month", 0, { sessions: [{ startDate: "2026-12-20", precision: "day" }] });
  await update("before", 0.5, { price });

  // The agent searched on day 1. What happened after:
  await update("confirmed", 5, { status: "confirmed", booking: "open" });
  await update("rescheduled", 6, { sessions: [{ startDate: "2027-06-14", precision: "day", startTime: "18:00" }] });
  await update("postponed", 7, { status: "postponed" });
  // The source marks the evening itself cancelled too, so no session of it is scheduled any more.
  await update("cancelled", 8, {
    status: "cancelled",
    sessions: [{ startDate: "2027-06-12", precision: "day", startTime: "18:00", endTime: "22:00", cancelled: true }],
  });
  clock.now = at(9);
  const removed = saved.get("removed");
  assert.ok(removed);
  await catalogue.removeSourceLink({ listingId: removed.input.source.listingId, rawListingId: randomUUID() });
  await update("price", 10, { price });
  await create("new", 11);
  for (const name of ["far", "december", "this month"]) await update(name, 12, { price });
  await update("december cancelled", 12.5, { status: "cancelled" });
  await update("confirmed", 13, { price });
  // The evening on 10 December is over by now.
  clock.now = at(15);
  assert.equal((await catalogue.keepUp()).past, 1);

  // Moves out of and into 1 to 10 September 2027. Created before the search, unless named new.
  const evening = (startDate: string, cancelled?: boolean) => [
    { startDate, precision: "day" as const, startTime: "18:00", endTime: "22:00", ...(cancelled === true ? { cancelled } : {}) },
  ];
  const market = (start: string, end: string) => ({
    type: "recurring" as const,
    sessions: [],
    recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start, end },
  });
  clock.now = at(0);
  await create("moved out", 0, { sessions: evening("2027-09-05") });
  await create("market moved out", 0, market("2027-09-01", "2027-09-30"));
  await create("evening cancelled", 0, { sessions: evening("2027-09-07") });
  await create("never in", 0, { sessions: evening("2027-10-01") });
  await create("new then moved", 11, { sessions: evening("2027-09-06") });
  await update("moved out", 16, { sessions: evening("2027-10-20") });
  await update("market moved out", 17, market("2027-10-01", "2027-10-31"));
  await update("evening cancelled", 18, { sessions: evening("2027-09-07", true) });
  await update("never in", 19, { sessions: evening("2027-10-25") });
  await update("new then moved", 20, { sessions: evening("2027-10-21") });

  clock.now = at(30);
});

after(async () => {
  await harness.close();
});

describe("checking back on day 30", () => {
  test("reports exactly what changed since, each with its kind, the most recent change first", async () => {
    const result = experienceChangesResultSchema.parse(await changes());
    assert.deepEqual(names(result), ["confirmed", "new", "price", "removed", "cancelled", "postponed", "rescheduled"]);
    assert.equal(result.total, 7);
    assert.deepEqual(
      result.items.map((item) => [item.change.kind, item.change.at]),
      [
        ["confirmed", at(5).toISOString()],
        ["new", at(11).toISOString()],
        ["changed", at(10).toISOString()],
        ["removed", at(9).toISOString()],
        ["cancelled", at(8).toISOString()],
        ["postponed", at(7).toISOString()],
        ["rescheduled", at(6).toISOString()],
      ],
    );
  });

  test("an experience changed several times reports what matters most, and lists every change newest first", async () => {
    const [confirmed] = (await changes()).items;
    assert.deepEqual(confirmed?.changes, [
      { kind: "changed", at: at(13).toISOString() },
      { kind: "confirmed", at: at(5).toISOString() },
    ]);
    assert.deepEqual([confirmed.experience.status, confirmed.experience.bookable], ["confirmed", true]);
  });

  test("each experience is as search returns it, with its sessions inside the dates", async () => {
    const result = await changes();
    const byName = new Map(names(result).map((name, index) => [name, result.items[index]]));
    assert.deepEqual(
      byName.get("rescheduled")?.experience.sessions.map((session) => session.startDate),
      ["2027-06-14"],
    );
    assert.deepEqual(byName.get("price")?.experience.price, price);
    assert.equal(byName.get("new")?.experience.distanceKm, 0.5);
  });

  test("cancelled and removed experiences are found with their final status, though search no longer returns them", async () => {
    const result = await changes();
    const byName = new Map(names(result).map((name, index) => [name, result.items[index]]));
    const cancelled = byName.get("cancelled")?.experience;
    assert.deepEqual([cancelled?.status, cancelled?.booking, cancelled?.bookable], ["cancelled", "closed", false]);
    assert.deepEqual(
      cancelled?.sessions.map((session) => session.startDate),
      ["2027-06-12"],
    );
    assert.equal(byName.get("removed")?.experience.status, "removed");

    const search = await catalogue.searchExperiences({
      near: HERMANUS,
      from: "2027-06-10",
      to: "2027-06-20",
      limit: 20,
      offset: 0,
    });
    const searched = new Set(search.items.map((item) => item.id));
    for (const name of ["cancelled", "removed"]) assert.equal(searched.has(saved.get(name)?.id ?? ""), false, name);
  });

  test("a filter holds: outside the radius or the dates nothing is reported, cancelled or not", async () => {
    // Within the default radius nothing in Cape Town is reported; within 200 km it is.
    assert.ok(names(await changes({ radiusKm: 200 })).includes("far"));
    assert.deepEqual(names(await changes({ from: "2027-12-01", to: "2027-12-31" })), [
      "december cancelled",
      "december",
    ]);
    assert.deepEqual(names(await changes({ attributes: { category: ["sport"] } })), []);
  });

  test("a status filter narrows the experiences that are going ahead, and cancelled and removed ones stay", async () => {
    assert.deepEqual(names(await changes({ status: ["postponed"] })), ["removed", "cancelled", "postponed"]);
    // Every confirmed one here has booking open; the postponed one is left out.
    assert.deepEqual(names(await changes({ bookable: true })), [
      "confirmed",
      "new",
      "price",
      "removed",
      "cancelled",
      "rescheduled",
    ]);
  });

  test("an experience that only became Past is not reported", async () => {
    assert.deepEqual(names(await changes({ from: "2026-12-01", to: "2026-12-31" })), ["this month"]);
  });

  test("a later time reports only the later changes", async () => {
    assert.deepEqual(names(await changes({ since: at(10.5).toISOString() })), ["confirmed", "new"]);
    assert.deepEqual(names(await changes({ since: at(30).toISOString() })), []);
  });

  test("pages with its own limit and offset", async () => {
    const page = await changes({ limit: 3, offset: 3 });
    assert.deepEqual(names(page), ["removed", "cancelled", "postponed"]);
    assert.deepEqual([page.total, page.limit, page.offset], [7, 3, 3]);
  });
});

describe("an experience that moved out of the dates searched", () => {
  const september = { from: "2027-09-01", to: "2027-09-10" };

  test("is reported with the change it got, marked moved out, with the sessions it has now", async () => {
    const result = experienceChangesResultSchema.parse(await changes(september));
    assert.deepEqual(names(result), ["evening cancelled", "market moved out", "moved out"]);
    assert.deepEqual(
      result.items.map((item) => [item.change.kind, item.movedOut]),
      [
        ["changed", true],
        ["rescheduled", true],
        ["rescheduled", true],
      ],
    );
    const dates = result.items.map((item) => item.experience.sessions.map((session) => session.startDate));
    // The cancelled evening has no scheduled session left; the others carry where they moved to.
    assert.deepEqual(dates[0], []);
    assert.deepEqual(dates[1], ["2027-10-02", "2027-10-09", "2027-10-16", "2027-10-23", "2027-10-30"]);
    assert.deepEqual(dates[2], ["2027-10-20"]);
  });

  test("one that was never in the dates, or was published after the search, is not reported", async () => {
    const reported = names(await changes(september));
    assert.equal(reported.includes("never in"), false);
    assert.equal(reported.includes("new then moved"), false);
  });

  test("for the dates it moved into, it is reported as search returns it, not moved out", async () => {
    const result = await changes({ from: "2027-10-18", to: "2027-10-26" });
    assert.deepEqual(names(result), ["new then moved", "never in", "market moved out", "moved out"]);
    assert.deepEqual(
      result.items.map((item) => [item.change.kind, item.movedOut]),
      [
        ["new", false],
        ["rescheduled", false],
        ["rescheduled", false],
        ["rescheduled", false],
      ],
    );
  });

  test("the filters still hold, and a change before the time given does not count", async () => {
    assert.deepEqual(names(await changes({ ...september, attributes: { category: ["sport"] } })), []);
    assert.deepEqual(names(await changes({ ...september, status: ["postponed"] })), []);
    // Since day 16.5 the one moved out on day 16 is not reported, and the one published on day 11 was in the
    // dates then, so it is.
    assert.deepEqual(names(await changes({ ...september, since: at(16.5).toISOString() })), [
      "new then moved",
      "evening cancelled",
      "market moved out",
    ]);
  });
});
