import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeCatalogue, input } from "./helpers/catalogue-fake.ts";

// Catalogue's upkeep with no database. The jazz evening of the fake's input is on 13 March 2027 in Hermanus
// (UTC+2), and its booking closes at 16:00 UTC on 12 March.

const NO_CLOSE = { bookingClosesAt: undefined };

async function saved(catalogue: ReturnType<typeof fakeCatalogue>, overrides: Parameters<typeof input>[0] = {}) {
  const { experience } = await catalogue.service.saveExperience(input(overrides));
  return experience.id;
}

function lastWrite(catalogue: ReturnType<typeof fakeCatalogue>, id: string) {
  return catalogue.writes.filter((write) => write.experience.id === id).at(-1);
}

describe("moving finished experiences to Past", () => {
  test("a confirmed experience is Past once its last day is over in its own timezone, with booking Closed", async () => {
    const catalogue = fakeCatalogue();
    const id = await saved(catalogue, NO_CLOSE);

    // 23:30 in Hermanus on the day itself: it is still on.
    catalogue.at("2027-03-13T21:30:00.000Z");
    assert.deepEqual(await catalogue.service.keepUp(), { past: 0, bookingsClosed: 0, sessionsGenerated: 0 });
    assert.equal(catalogue.experiences.get(id)?.status, "confirmed");

    // 00:30 the next day in Hermanus, though still the 13th in UTC.
    catalogue.at("2027-03-13T22:30:00.000Z");
    assert.deepEqual(await catalogue.service.keepUp(), { past: 1, bookingsClosed: 0, sessionsGenerated: 0 });
    const stored = catalogue.experiences.get(id);
    assert.deepEqual([stored?.status, stored?.booking, stored?.version], ["past", "closed", 2]);

    const write = lastWrite(catalogue, id);
    assert.equal(write?.change?.kind, "past");
    assert.deepEqual(write?.change?.previous, { status: "confirmed", booking: "open" });
    assert.deepEqual(catalogue.publishedEvents().at(-1), {
      type: "experience.changed",
      resourceId: id,
      data: { version: 2, change: "past" },
    });

    // Past is final: nothing more is done to it.
    catalogue.at("2027-04-01T10:00:00.000Z");
    assert.deepEqual(await catalogue.service.keepUp(), { past: 0, bookingsClosed: 0, sessionsGenerated: 0 });
  });

  test("Expected and Announced experiences become Past too, and a booking of None stays None", async () => {
    const catalogue = fakeCatalogue();
    const expected = await saved(catalogue, { status: "expected", booking: "none", ...NO_CLOSE });
    const announced = await saved(catalogue, {
      title: "Cliff Path Walk",
      status: "announced",
      booking: "not_yet",
      ...NO_CLOSE,
      source: { listingId: "00000000-0000-4000-8000-0000000000c1", rawListingId: "00000000-0000-4000-8000-0000000000c2" },
    });
    catalogue.at("2027-03-15T10:00:00.000Z");
    assert.equal((await catalogue.service.keepUp()).past, 2);
    assert.deepEqual(
      [expected, announced].map((id) => [catalogue.experiences.get(id)?.status, catalogue.experiences.get(id)?.booking]),
      [
        ["past", "none"],
        ["past", "closed"],
      ],
    );
  });

  test("Postponed and Cancelled experiences never become Past", async () => {
    const catalogue = fakeCatalogue();
    const postponed = await saved(catalogue, { status: "postponed", ...NO_CLOSE });
    const cancelled = await saved(catalogue, {
      title: "Cancelled Jazz",
      status: "cancelled",
      ...NO_CLOSE,
      source: { listingId: "00000000-0000-4000-8000-0000000000c1", rawListingId: "00000000-0000-4000-8000-0000000000c2" },
    });
    catalogue.at("2027-04-01T10:00:00.000Z");
    assert.deepEqual(await catalogue.service.keepUp(), { past: 0, bookingsClosed: 0, sessionsGenerated: 0 });
    assert.deepEqual(
      [postponed, cancelled].map((id) => catalogue.experiences.get(id)?.status),
      ["postponed", "cancelled"],
    );
  });

  test("a recurring experience with a last date becomes Past after it", async () => {
    const catalogue = fakeCatalogue();
    const id = await saved(catalogue, {
      type: "recurring",
      booking: "none",
      sessions: [],
      ...NO_CLOSE,
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-28", end: "2026-12-19" },
    });
    catalogue.at("2026-12-19T12:00:00.000Z");
    assert.equal((await catalogue.service.keepUp()).past, 0);
    catalogue.at("2026-12-20T12:00:00.000Z");
    assert.equal((await catalogue.service.keepUp()).past, 1);
    assert.equal(catalogue.experiences.get(id)?.status, "past");
  });
});

describe("closing bookings", () => {
  test("an open booking is Closed once its close time has passed, as a change", async () => {
    const catalogue = fakeCatalogue();
    const id = await saved(catalogue);
    catalogue.at("2027-03-12T15:59:00.000Z");
    assert.equal((await catalogue.service.keepUp()).bookingsClosed, 0);

    catalogue.at("2027-03-12T16:00:00.000Z");
    assert.deepEqual(await catalogue.service.keepUp(), { past: 0, bookingsClosed: 1, sessionsGenerated: 0 });
    const stored = catalogue.experiences.get(id);
    assert.deepEqual([stored?.status, stored?.booking, stored?.version], ["confirmed", "closed", 2]);
    assert.deepEqual(lastWrite(catalogue, id)?.change, { kind: "changed", previous: { booking: "open" } });
    assert.deepEqual(catalogue.publishedEvents().at(-1)?.data, { version: 2, change: "changed" });

    // Closed once: the next run has nothing to do until the evening is over.
    assert.equal((await catalogue.service.keepUp()).bookingsClosed, 0);
  });

  test("a booking that is Not yet is Closed too, and None is left alone", async () => {
    const catalogue = fakeCatalogue();
    const notYet = await saved(catalogue, { status: "announced", booking: "not_yet" });
    const none = await saved(catalogue, {
      title: "Free Jazz",
      booking: "none",
      source: { listingId: "00000000-0000-4000-8000-0000000000c1", rawListingId: "00000000-0000-4000-8000-0000000000c2" },
    });
    catalogue.at("2027-03-12T17:00:00.000Z");
    assert.equal((await catalogue.service.keepUp()).bookingsClosed, 1);
    assert.deepEqual(
      [notYet, none].map((id) => catalogue.experiences.get(id)?.booking),
      ["closed", "none"],
    );
  });

  test("an experience that is over and past its close time is one version, Past", async () => {
    const catalogue = fakeCatalogue();
    const id = await saved(catalogue);
    catalogue.at("2027-03-20T10:00:00.000Z");
    assert.deepEqual(await catalogue.service.keepUp(), { past: 1, bookingsClosed: 0, sessionsGenerated: 0 });
    assert.equal(catalogue.experiences.get(id)?.version, 2);
  });
});

describe("generating sessions further ahead", () => {
  const market = {
    title: "Hermanus Country Market",
    type: "recurring" as const,
    status: "confirmed" as const,
    booking: "none" as const,
    sessions: [],
    ...NO_CLOSE,
    recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-28", startTime: "09:00", endTime: "13:00" },
  };

  test("an open-ended recurring experience gets the dates up to the horizon, with no version", async () => {
    const catalogue = fakeCatalogue();
    const id = await saved(catalogue, market);
    const before = catalogue.experiences.get(id)?.sessions ?? [];
    assert.equal(before.at(-1)?.startDate, "2028-11-18");
    const events = catalogue.published.length;

    // Two months on, the horizon is 23 January 2029.
    catalogue.at("2027-01-23T10:00:00.000Z");
    const result = await catalogue.service.keepUp();
    assert.deepEqual(result, { past: 0, bookingsClosed: 0, sessionsGenerated: 9 });

    const stored = catalogue.experiences.get(id);
    assert.equal(stored?.sessions.at(-1)?.startDate, "2029-01-20");
    assert.equal(stored?.version, 1);
    assert.equal(stored?.status, "confirmed");
    const write = lastWrite(catalogue, id);
    assert.deepEqual([write?.change, write?.event, write?.replace.sessions], [null, null, true]);
    assert.equal(catalogue.published.length, events);

    // The same day again: nothing new.
    assert.deepEqual(await catalogue.service.keepUp(), { past: 0, bookingsClosed: 0, sessionsGenerated: 0 });
  });

  test("leaves out skipped dates and dates a listed session covers, and never makes it Past", async () => {
    const catalogue = fakeCatalogue();
    const id = await saved(catalogue, {
      ...market,
      sessions: [{ startDate: "2028-12-02", precision: "day", label: "Christmas market" }],
      recurrence: { ...market.recurrence, skipped: ["2028-12-09"] },
    });
    catalogue.at("2026-12-23T10:00:00.000Z");
    assert.deepEqual(await catalogue.service.keepUp(), { past: 0, bookingsClosed: 0, sessionsGenerated: 3 });
    const days = (catalogue.experiences.get(id)?.sessions ?? [])
      .filter((session) => session.startDate >= "2028-11-25")
      .map((session) => [session.startDate, session.origin]);
    assert.deepEqual(days, [
      ["2028-11-25", "generated"],
      ["2028-12-02", "listed"],
      ["2028-12-16", "generated"],
      ["2028-12-23", "generated"],
    ]);
  });

  test("a final recurring experience gets no more sessions", async () => {
    const catalogue = fakeCatalogue();
    const id = await saved(catalogue, { ...market, status: "cancelled" });
    catalogue.at("2027-01-23T10:00:00.000Z");
    assert.equal((await catalogue.service.keepUp()).sessionsGenerated, 0);
    assert.equal(catalogue.experiences.get(id)?.sessions.at(-1)?.startDate, "2028-11-18");
  });
});

describe("running over the catalogue", () => {
  test("one experience that fails is logged, and the rest are kept up", async () => {
    const catalogue = fakeCatalogue();
    const first = await saved(catalogue, NO_CLOSE);
    const second = await saved(catalogue, {
      title: "Second Jazz",
      ...NO_CLOSE,
      source: { listingId: "00000000-0000-4000-8000-0000000000c1", rawListingId: "00000000-0000-4000-8000-0000000000c2" },
    });
    const [failing, kept] = [first, second].sort();
    assert.ok(failing !== undefined && kept !== undefined);
    catalogue.failing.add(failing);
    catalogue.at("2027-03-20T10:00:00.000Z");
    assert.equal((await catalogue.service.keepUp()).past, 1);
    assert.equal(catalogue.experiences.get(kept)?.status, "past");
    assert.equal(catalogue.experiences.get(failing)?.status, "confirmed");
    assert.deepEqual(
      catalogue.errors.map((one) => [one.message, (one.context as { experienceId: string }).experienceId]),
      [["Upkeep of an experience failed", failing]],
    );
  });

  test("works through a large catalogue in batches", async () => {
    const catalogue = fakeCatalogue();
    for (let index = 0; index < 450; index += 1) {
      const suffix = String(index).padStart(12, "0");
      await saved(catalogue, {
        title: `Jazz ${String(index)}`,
        ...NO_CLOSE,
        source: { listingId: `00000000-0000-4000-8000-${suffix}`, rawListingId: `00000000-0000-4000-9000-${suffix}` },
      });
    }
    catalogue.at("2027-03-20T10:00:00.000Z");
    assert.equal((await catalogue.service.keepUp()).past, 450);
    assert.deepEqual(catalogue.upkeepLimits, [200, 200, 200]);
  });
});
