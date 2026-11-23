import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExperienceStatus, SavableStatus, SaveExperienceInput } from "../src/catalogue/ports.ts";
import { AppError } from "../src/shared/errors.ts";
import { precedenceOf } from "../src/data-processing/match.ts";
import { fakeCatalogue, input, LISTING_A, LISTING_B, RAW_A, RAW_B } from "../src/testing/catalogue-fake.ts";

// The save rules with no database: an in-memory repository and a fixed clock, 23 November 2026.

async function created(catalogue: ReturnType<typeof fakeCatalogue>, overrides: Partial<SaveExperienceInput> = {}) {
  const result = await catalogue.service.saveExperience(input(overrides));
  return result.experience.id;
}

async function refused(promise: Promise<unknown>, path: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "invalid_input");
    assert.ok(
      error.details?.some((detail) => detail.path === path),
      `expected a problem at ${path}, got ${JSON.stringify(error.details)}`,
    );
    return;
  }
  assert.fail("expected the save to be refused");
}

describe("creating an experience", () => {
  test("stores version 1 with its sessions, link, change row and domain event", async () => {
    const catalogue = fakeCatalogue();
    const result = await catalogue.service.saveExperience(input());

    assert.equal(result.created, true);
    assert.equal(result.changed, true);
    assert.equal(result.change, "new");
    const saved = result.experience;
    assert.equal(saved.version, 1);
    assert.equal(saved.slug, "jazz-on-the-cliffs");
    assert.equal(saved.timezone, "Africa/Johannesburg");
    assert.deepEqual(saved.listingIds, [LISTING_A]);
    assert.deepEqual(saved.sessions, [
      {
        startDate: "2027-03-13",
        endDate: "2027-03-13",
        precision: "day",
        startTime: "18:00:00",
        endTime: "22:00:00",
        label: null,
        soldOut: false,
        status: "scheduled",
        origin: "listed",
      },
    ]);

    const [write] = catalogue.writes;
    assert.ok(write);
    assert.equal(write.previousVersion, null);
    assert.deepEqual(write.links, { add: [LISTING_A], remove: [] });
    assert.deepEqual(write.change, { kind: "new", previous: null });
    assert.deepEqual(write.event, { type: "experience.published", data: { version: 1, raw_listing_id: RAW_A } });

    // The event the repository appended is the one published, once.
    assert.equal(catalogue.published.length, 1);
    assert.deepEqual(catalogue.publishedEvents(), [
      { type: "experience.published", resourceId: saved.id, data: { version: 1, raw_listing_id: RAW_A } },
    ]);
    assert.equal(catalogue.published[0]?.recordedAt, "2026-11-23T10:00:00.000Z");
  });

  test("gives a taken slug the year of its first date, then a counter", async () => {
    const catalogue = fakeCatalogue();
    const slugs = [];
    for (let index = 0; index < 3; index += 1) {
      slugs.push((await catalogue.service.saveExperience(input())).experience.slug);
    }
    const undated = await catalogue.service.saveExperience(input({ sessions: [] }));
    assert.deepEqual(slugs, ["jazz-on-the-cliffs", "jazz-on-the-cliffs-2027", "jazz-on-the-cliffs-2027-2"]);
    assert.equal(undated.experience.slug, "jazz-on-the-cliffs-2");
  });

  test("slugs a title with accents and symbols", async () => {
    const catalogue = fakeCatalogue();
    const result = await catalogue.service.saveExperience(input({ title: "Kalfiefees: Fées & Musiek!" }));
    assert.equal(result.experience.slug, "kalfiefees-fees-musiek");
  });

  test("refuses an unknown location", async () => {
    const catalogue = fakeCatalogue();
    await refused(
      catalogue.service.saveExperience(input({ locationId: "00000000-0000-4000-8000-0000000000ff" })),
      "locationId",
    );
  });

  test("refuses an update of an experience that does not exist", async () => {
    const catalogue = fakeCatalogue();
    await assert.rejects(
      catalogue.service.saveExperience(input({ experienceId: "00000000-0000-4000-8000-0000000000ff" })),
      (error) => error instanceof AppError && error.code === "not_found",
    );
  });
});

describe("sessions as stored", () => {
  test("default the end date by precision and sit month and year sessions on their boundaries", async () => {
    const catalogue = fakeCatalogue();
    const result = await catalogue.service.saveExperience(
      input({
        type: "run",
        sessions: [
          { startDate: "2027-06-01", precision: "month" },
          { startDate: "2027-06-15", endDate: "2027-11-02", precision: "month" },
          { startDate: "2028-01-01", precision: "year" },
          { startDate: "2027-02-27", precision: "day", cancelled: true, soldOut: true, label: " Matinee " },
        ],
      }),
    );
    assert.deepEqual(
      result.experience.sessions.map(({ startDate, endDate, precision, status, soldOut, label }) => ({
        startDate,
        endDate,
        precision,
        status,
        soldOut,
        label,
      })),
      [
        { startDate: "2027-02-27", endDate: "2027-02-27", precision: "day", status: "cancelled", soldOut: true, label: "Matinee" },
        { startDate: "2027-06-01", endDate: "2027-06-30", precision: "month", status: "scheduled", soldOut: false, label: null },
        { startDate: "2027-06-01", endDate: "2027-11-30", precision: "month", status: "scheduled", soldOut: false, label: null },
        { startDate: "2028-01-01", endDate: "2028-12-31", precision: "year", status: "scheduled", soldOut: false, label: null },
      ],
    );
  });
});

describe("validation", () => {
  const cases: [string, Partial<SaveExperienceInput>, string][] = [
    ["an end before its start", { sessions: [{ startDate: "2027-03-13", endDate: "2027-03-12", precision: "day" }] }, "sessions.0.endDate"],
    ["a time on a month session", { sessions: [{ startDate: "2027-06-01", precision: "month", startTime: "10:00" }] }, "sessions.0"],
    ["a time on a year session", { sessions: [{ startDate: "2027-01-01", precision: "year", endTime: "10:00" }] }, "sessions.0"],
    ["a date that is not a date", { sessions: [{ startDate: "2027-02-30", precision: "day" }] }, "sessions.0.startDate"],
    ["a time that is not a time", { sessions: [{ startDate: "2027-03-13", precision: "day", startTime: "25:00" }] }, "sessions.0.startTime"],
    [
      "a single with two sessions",
      {
        sessions: [
          { startDate: "2027-03-13", precision: "day" },
          { startDate: "2027-03-14", precision: "day" },
        ],
      },
      "sessions",
    ],
    ["a recurrence on a run", { type: "run", recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2027-01-02" } }, "recurrence"],
    ["a recurring experience with no recurrence", { type: "recurring", sessions: [] }, "recurrence"],
    [
      "a rule that cannot be parsed",
      { type: "recurring", sessions: [], recurrence: { rule: "EVERY SATURDAY", start: "2027-01-02" } },
      "recurrence.rule",
    ],
    [
      "a rule that repeats within a day",
      { type: "recurring", sessions: [], recurrence: { rule: "FREQ=HOURLY", start: "2027-01-02" } },
      "recurrence.rule",
    ],
    [
      "a recurrence that ends before it starts",
      { type: "recurring", sessions: [], recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2027-01-02", end: "2026-12-01" } },
      "recurrence.end",
    ],
    ["an empty title", { title: "  " }, "title"],
    ["an on-sale time that is not a time", { onSaleAt: "soon" }, "onSaleAt"],
  ];
  for (const [name, overrides, path] of cases) {
    test(`refuses ${name}`, async () => {
      const catalogue = fakeCatalogue();
      await refused(catalogue.service.saveExperience(input(overrides)), path);
      assert.equal(catalogue.writes.length, 0);
    });
  }
});

describe("an update with precedence lead", () => {
  test("replaces every field, and a field left out becomes empty", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience({
      experienceId: id,
      locationId: input().locationId,
      title: "Jazz on the Cliffs 2027",
      type: "run",
      status: "confirmed",
      booking: "none",
      sessions: [
        { startDate: "2027-03-13", precision: "day" },
        { startDate: "2027-03-20", precision: "day" },
      ],
      attributes: { category: ["festival"] },
      tags: ["live-music"],
      source: { listingId: LISTING_A, rawListingId: RAW_B },
      precedence: "lead",
    });

    const saved = result.experience;
    assert.equal(result.changed, true);
    assert.equal(saved.version, 2);
    assert.equal(saved.slug, "jazz-on-the-cliffs");
    assert.equal(saved.title, "Jazz on the Cliffs 2027");
    assert.equal(saved.type, "run");
    assert.equal(saved.summary, null);
    assert.equal(saved.description, null);
    assert.equal(saved.profile, null);
    assert.equal(saved.openingHours, null);
    assert.deepEqual(saved.venue, { name: null, address: null, city: null, position: null });
    assert.deepEqual(saved.price, { min: null, max: null, currency: null });
    assert.equal(saved.onSaleAt, null);
    assert.equal(saved.bookingClosesAt, null);
    assert.equal(saved.bookingUrl, null);
    assert.equal(saved.imageUrl, null);
    assert.equal(saved.pageUrl, null);
    assert.equal(saved.booking, "none");
    assert.deepEqual(
      saved.sessions.map((session) => [session.startDate, session.startTime]),
      [
        ["2027-03-13", null],
        ["2027-03-20", null],
      ],
    );
    assert.deepEqual(saved.attributes, { category: ["festival"] });
    assert.deepEqual(saved.tags, ["live-music"]);

    const write = catalogue.writes[1];
    assert.ok(write);
    assert.deepEqual(write.replace, { sessions: true, attributes: true, tags: true });
    assert.equal(write.clearEmbedding, true);
    assert.equal(write.change?.kind, "rescheduled");
    assert.deepEqual(write.change.previous?.title, "Jazz on the Cliffs");
    assert.deepEqual(write.change.previous.booking, "open");
    assert.equal(write.change.previous.profile, undefined);
    assert.deepEqual(write.event, {
      type: "experience.changed",
      data: { version: 2, change: "rescheduled", raw_listing_id: RAW_B },
    });
    assert.deepEqual(catalogue.publishedEvents(), [
      { type: "experience.published", resourceId: id, data: { version: 1, raw_listing_id: RAW_A } },
      { type: "experience.changed", resourceId: id, data: { version: 2, change: "rescheduled", raw_listing_id: RAW_B } },
    ]);
  });

  test("writes nothing when nothing changed", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(input({ experienceId: id }));
    assert.deepEqual(
      { changed: result.changed, change: result.change, created: result.created, version: result.experience.version },
      { changed: false, change: null, created: false, version: 1 },
    );
    assert.equal(catalogue.writes.length, 1);
    assert.deepEqual(
      catalogue.publishedEvents().map((event) => event.type),
      ["experience.published"],
    );
  });

  test("writes nothing when only the form of the values differs", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(
      input({
        experienceId: id,
        title: " Jazz on the Cliffs ",
        onSaleAt: "2027-01-10T11:00:00+02:00",
        sessions: [{ startDate: "2027-03-13", precision: "day", startTime: "18:00:00", endTime: "22:00" }],
        attributes: { audience: ["adults"], category: ["music", "music"] },
        tags: ["jazz", "jazz"],
      }),
    );
    assert.equal(result.changed, false);
    assert.equal(catalogue.writes.length, 1);
    assert.equal(catalogue.published.length, 1);
  });

  test("saves a change to the profile alone with no version, change row or domain event", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(input({ experienceId: id, profile: "Jazz, in other words." }));

    assert.equal(result.changed, false);
    assert.equal(result.change, null);
    assert.equal(result.experience.version, 1);
    assert.equal(result.experience.profile, "Jazz, in other words.");
    const write = catalogue.writes[1];
    assert.ok(write);
    assert.equal(write.change, null);
    assert.equal(write.event, null);
    assert.equal(write.clearEmbedding, true);
    assert.deepEqual(
      catalogue.publishedEvents().map((event) => event.type),
      ["experience.published"],
    );
  });

  test("keeps the embedding when neither the title nor the profile changed", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    await catalogue.service.saveExperience(input({ experienceId: id, imageUrl: "https://tickets.example.com/new.jpg" }));
    assert.equal(catalogue.writes[1]?.clearEmbedding, false);
    assert.deepEqual(catalogue.writes[1].replace, { sessions: false, attributes: false, tags: false });
  });

  test("a new page address is a new version, reported as changed", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(
      input({ experienceId: id, pageUrl: "https://whatson.example.com/jazz-2027" }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.change, "changed");
    assert.equal(result.experience.pageUrl, "https://whatson.example.com/jazz-2027");
    assert.deepEqual(catalogue.writes[1]?.change?.previous, { pageUrl: "https://whatson.example.com/jazz-on-the-cliffs" });
  });
});

describe("an experience with several listings", () => {
  const LISTING_C = "00000000-0000-4000-8000-00000000000c";
  const SEASONS = ["whale-season", "winter"];
  // A listing that states nothing beyond its title, dates, status and booking, with the overrides.
  const bare = (listingId: string, overrides: Partial<SaveExperienceInput> = {}): SaveExperienceInput => ({
    ...input({
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
      ...overrides,
    }),
    source: { listingId, rawListingId: crypto.randomUUID() },
  });
  // Three listings, each stating something the others do not. A leads; B and C have the same, lower priority.
  const listings: Record<string, { priority: number; input: SaveExperienceInput }> = {
    A: {
      priority: 10,
      input: bare(LISTING_A, {
        venue: { name: "Hermanus Golf Club" },
        price: { min: 200, max: 400, currency: "ZAR" },
        bookingUrl: "https://tickets.example.com/rumours",
        sessions: [{ startDate: "2027-06-12", precision: "day", startTime: "19:00" }],
        attributes: { category: ["music"] },
        tags: ["rock-and-pop", "whale-season", "winter"],
      }),
    },
    B: {
      priority: 5,
      input: bare(LISTING_B, {
        summary: "A Fleetwood Mac tribute.",
        venue: { position: { lat: -34.41, lng: 19.24 } },
        sessions: [{ startDate: "2027-06-13", precision: "day" }],
        attributes: { setting: ["indoor"] },
        tags: ["tribute", "winter"],
      }),
    },
    C: {
      priority: 5,
      input: bare(LISTING_C, {
        description: "The hits of Rumours, live.",
        imageUrl: "https://whatson.example.com/rumours.jpg",
        sessions: [{ startDate: "2027-07-01", precision: "day" }],
        attributes: { audience: ["all_ages"], category: ["performing_arts"] },
        tags: ["classic-rock"],
      }),
    },
  };

  // Processes a listing as Data processing does: the first creates the experience, and each later one leads or
  // fills by the priorities of the listings linked to it.
  async function process(catalogue: ReturnType<typeof fakeCatalogue>, name: string): Promise<void> {
    const listing = listings[name];
    assert.ok(listing);
    const [stored] = [...catalogue.experiences.values()];
    if (stored === undefined) {
      await catalogue.service.saveExperience({ ...listing.input, precedence: "lead" });
      return;
    }
    const priorityOf = (listingId: string) =>
      Object.values(listings).find((one) => one.input.source.listingId === listingId)?.priority ?? 0;
    const linked = stored.listingIds.map((listingId) => ({ listingId, priority: priorityOf(listingId) }));
    const own = { listingId: listing.input.source.listingId, priority: listing.priority };
    await catalogue.service.saveExperience({
      ...listing.input,
      experienceId: stored.id,
      source: { ...listing.input.source, rawListingId: crypto.randomUUID() },
      precedence: precedenceOf(own, linked),
    });
  }

  const orders = [
    ["A", "B", "C"],
    ["A", "C", "B"],
    ["B", "A", "C"],
    ["B", "C", "A"],
    ["C", "A", "B"],
    ["C", "B", "A"],
  ];

  for (const order of orders) {
    test(`processed first as ${order.join(", ")}, then again in any order, writes no new version`, async () => {
      const catalogue = fakeCatalogue();
      for (const name of order) await process(catalogue, name);
      const [first] = [...catalogue.experiences.values()];
      assert.ok(first);
      const published = catalogue.published.length;
      const changes = catalogue.writes.filter((write) => write.change !== null).length;

      for (const name of ["A", "B", "C", "C", "B", "A", "B", "A", "C"]) await process(catalogue, name);
      const [again] = [...catalogue.experiences.values()];
      assert.equal(again?.version, first.version);
      assert.equal(catalogue.writes.filter((write) => write.change !== null).length, changes);
      assert.equal(catalogue.published.length, published);

      // The leader's values where it states them, the others' where it does not, whatever the order.
      assert.deepEqual(again.venue, {
        name: "Hermanus Golf Club",
        address: null,
        city: null,
        position: { lat: -34.41, lng: 19.24 },
      });
      assert.deepEqual(again.price, { min: 200, max: 400, currency: "ZAR" });
      assert.equal(again.summary, "A Fleetwood Mac tribute.");
      assert.equal(again.description, "The hits of Rumours, live.");
      assert.equal(again.imageUrl, "https://whatson.example.com/rumours.jpg");
      assert.deepEqual(again.attributes, { audience: ["all_ages"], category: ["music"], setting: ["indoor"] });
      // The seasons are the ones the leader's dates give; the other tags are everyone's.
      assert.deepEqual(again.tags, ["classic-rock", "rock-and-pop", "tribute", "whale-season", "winter"]);
      assert.deepEqual(
        again.sessions.map((session) => session.startDate),
        ["2027-06-12"],
      );
    });
  }

  test("a leader that changes a value it states changes the experience", async () => {
    const catalogue = fakeCatalogue();
    for (const name of ["A", "B", "C"]) await process(catalogue, name);
    const A = listings.A;
    assert.ok(A);
    const before = A.input;
    A.input = { ...before, price: { min: 250, max: 450, currency: "ZAR" } };
    try {
      await process(catalogue, "A");
    } finally {
      A.input = before;
    }
    const [saved] = [...catalogue.experiences.values()];
    assert.deepEqual(saved?.price, { min: 250, max: 450, currency: "ZAR" });
    assert.equal(saved.version, 4);
    // What the others gave is kept.
    assert.deepEqual(saved.attributes.setting, ["indoor"]);
  });

  test("a filler changes the experience only where nothing is stored", async () => {
    const catalogue = fakeCatalogue();
    for (const name of ["A", "B", "C"]) await process(catalogue, name);
    const B = listings.B;
    assert.ok(B);
    const before = B.input;
    // A different price, which the leader states, and opening hours, which nobody states.
    B.input = { ...before, price: { min: 1, currency: "ZAR" }, openingHours: "From 18:00" };
    try {
      await process(catalogue, "B");
    } finally {
      B.input = before;
    }
    const [saved] = [...catalogue.experiences.values()];
    assert.deepEqual(saved?.price, { min: 200, max: 400, currency: "ZAR" });
    assert.equal(saved.openingHours, "From 18:00");
  });

  test("a leader whose dates leave a season takes the season off, and keeps the other tags", async () => {
    const catalogue = fakeCatalogue();
    for (const name of ["A", "B"]) await process(catalogue, name);
    const A = listings.A;
    assert.ok(A);
    const before = A.input;
    // Moved to December: no longer in whale season or winter.
    A.input = { ...before, sessions: [{ startDate: "2027-12-04", precision: "day" }], tags: ["rock-and-pop"] };
    try {
      await process(catalogue, "A");
    } finally {
      A.input = before;
    }
    const [saved] = [...catalogue.experiences.values()];
    assert.deepEqual(saved?.tags, ["rock-and-pop", "tribute"]);
  });

  test("the leader as the only listing clears what it leaves empty", async () => {
    const catalogue = fakeCatalogue();
    await process(catalogue, "A");
    const A = listings.A;
    assert.ok(A);
    const before = A.input;
    A.input = { ...before, bookingUrl: undefined, attributes: {}, tags: [] };
    try {
      await process(catalogue, "A");
    } finally {
      A.input = before;
    }
    const [saved] = [...catalogue.experiences.values()];
    assert.equal(saved?.bookingUrl, null);
    assert.deepEqual(saved.attributes, {});
    assert.deepEqual(saved.tags, []);
  });
});

describe("an update with precedence fill", () => {
  test("fills only the fields that are empty and leaves status and booking", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(
      catalogue,
      {
        status: "announced",
        booking: "not_yet",
        summary: undefined,
        venue: { name: "Gearing's Point" },
        price: undefined,
        imageUrl: undefined,
        pageUrl: undefined,
        attributes: { category: ["music"] },
      },
    );
    const result = await catalogue.service.saveExperience(
      input({
        experienceId: id,
        title: "Jazz on the Cliffs (lower priority)",
        status: "cancelled",
        booking: "closed",
        summary: "Filled summary.",
        description: "Another description.",
        venue: {
          name: "Somewhere else",
          address: "1 Main Road",
          city: "Hermanus",
          position: { lat: -34.41, lng: 19.25 },
        },
        price: { min: 99, currency: "ZAR" },
        imageUrl: "https://other.example.com/jazz.jpg",
        pageUrl: "https://other.example.com/jazz",
        sessions: [{ startDate: "2027-04-01", precision: "day" }],
        attributes: { category: ["festival"], audience: ["family"] },
        tags: ["festival"],
        source: { listingId: LISTING_B, rawListingId: RAW_B },
        precedence: "fill",
      }),
    );

    const saved = result.experience;
    assert.equal(saved.title, "Jazz on the Cliffs");
    assert.equal(saved.status, "announced");
    assert.equal(saved.booking, "not_yet");
    assert.equal(saved.summary, "Filled summary.");
    assert.equal(saved.description, "Local and visiting players on the cliff path.");
    assert.deepEqual(saved.venue, {
      name: "Gearing's Point",
      address: "1 Main Road",
      city: "Hermanus",
      position: { lat: -34.41, lng: 19.25 },
    });
    assert.deepEqual(saved.price, { min: 99, max: null, currency: "ZAR" });
    assert.equal(saved.imageUrl, "https://other.example.com/jazz.jpg");
    assert.equal(saved.pageUrl, "https://other.example.com/jazz");
    assert.deepEqual(
      saved.sessions.map((session) => session.startDate),
      ["2027-03-13"],
    );
    assert.deepEqual(saved.attributes, { audience: ["family"], category: ["music"] });
    // Its tags are added, as its attribute keys are.
    assert.deepEqual(saved.tags, ["festival", "jazz"]);
    assert.deepEqual(saved.listingIds, [LISTING_A, LISTING_B]);
    assert.equal(result.change, "changed");
    assert.equal(saved.version, 2);
  });

  test("takes the dates and the type only when the experience has no sessions", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue, { sessions: [], tags: [] });
    const result = await catalogue.service.saveExperience(
      input({
        experienceId: id,
        type: "run",
        sessions: [
          { startDate: "2027-04-01", precision: "day" },
          { startDate: "2027-04-08", precision: "day" },
        ],
        tags: ["festival"],
        source: { listingId: LISTING_B, rawListingId: RAW_B },
        precedence: "fill",
      }),
    );
    assert.equal(result.experience.type, "run");
    assert.deepEqual(
      result.experience.sessions.map((session) => session.startDate),
      ["2027-04-01", "2027-04-08"],
    );
    assert.deepEqual(result.experience.tags, ["festival"]);
    assert.equal(result.change, "rescheduled");
  });

  test("leaves a page address that is already stored", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(
      input({
        experienceId: id,
        pageUrl: "https://other.example.com/jazz",
        source: { listingId: LISTING_B, rawListingId: RAW_B },
        precedence: "fill",
      }),
    );
    assert.equal(result.experience.pageUrl, "https://whatson.example.com/jazz-on-the-cliffs");
  });

  test("leaves a venue position that is already stored", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(
      input({
        experienceId: id,
        venue: { name: "Gearing's Point", position: { lat: -34.5, lng: 19.3 } },
        source: { listingId: LISTING_B, rawListingId: RAW_B },
        precedence: "fill",
      }),
    );
    assert.deepEqual(result.experience.venue.position, { lat: -34.42, lng: 19.24 });
  });

  test("adding the link of a new listing is a real change, even when it fills nothing", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(
      input({ experienceId: id, source: { listingId: LISTING_B, rawListingId: RAW_B }, precedence: "fill" }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.change, "changed");
    assert.equal(result.experience.version, 2);
    const write = catalogue.writes[1];
    assert.ok(write);
    assert.deepEqual(write.links, { add: [LISTING_B], remove: [] });
    assert.deepEqual(write.change?.previous, { listingIds: [LISTING_A] });
    assert.deepEqual(catalogue.publishedEvents()[1], {
      type: "experience.changed",
      resourceId: id,
      data: { version: 2, change: "changed", raw_listing_id: RAW_B },
    });
  });
});

describe("status moves", () => {
  // The status table in docs/data-model.md.
  const allowed: Record<ExperienceStatus, SavableStatus[]> = {
    expected: ["announced", "confirmed", "cancelled"],
    announced: ["confirmed", "postponed", "cancelled"],
    confirmed: ["postponed", "cancelled"],
    postponed: ["announced", "confirmed", "cancelled"],
    cancelled: [],
    removed: [],
    past: [],
  };
  const savable: SavableStatus[] = ["expected", "announced", "confirmed", "postponed", "cancelled"];

  for (const [from, targets] of Object.entries(allowed) as [ExperienceStatus, SavableStatus[]][]) {
    for (const to of savable) {
      if (to === from) continue;
      const allows = targets.includes(to);
      test(`${from} to ${to} is ${allows ? "allowed" : "refused"}`, async () => {
        const catalogue = fakeCatalogue();
        const id = await created(catalogue, { booking: "none" });
        catalogue.set(id, { status: from });
        const result = await catalogue.service.saveExperience(input({ experienceId: id, status: to, booking: "none" }));
        assert.equal(result.experience.status, allows ? to : from);
        const warned = catalogue.warnings.some((warning) => warning.message.startsWith("Status move not allowed"));
        const final = from === "cancelled" || from === "removed" || from === "past";
        assert.equal(warned, !allows && !final);
      });
    }
  }

  test("a save to a final experience changes none of its fields, and may add the link", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    catalogue.set(id, { status: "cancelled", booking: "closed" });
    const result = await catalogue.service.saveExperience(
      input({
        experienceId: id,
        title: "New title",
        status: "confirmed",
        sessions: [{ startDate: "2027-05-01", precision: "day" }],
        source: { listingId: LISTING_B, rawListingId: RAW_B },
      }),
    );
    assert.equal(result.experience.title, "Jazz on the Cliffs");
    assert.equal(result.experience.status, "cancelled");
    assert.equal(result.experience.sessions[0]?.startDate, "2027-03-13");
    assert.deepEqual(result.experience.listingIds, [LISTING_A, LISTING_B]);
    assert.equal(result.change, "changed");

    const again = await catalogue.service.saveExperience(input({ experienceId: id, title: "Another title" }));
    assert.equal(again.changed, false);
  });

  test("a refused move still saves the rest", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(
      input({ experienceId: id, status: "announced", booking: "open", title: "Renamed" }),
    );
    assert.equal(result.experience.status, "confirmed");
    assert.equal(result.experience.title, "Renamed");
    assert.equal(result.change, "changed");
  });
});

describe("booking", () => {
  const cases: [SavableStatus, SaveExperienceInput["booking"], SaveExperienceInput["booking"]][] = [
    ["confirmed", "open", "open"],
    ["confirmed", "sold_out", "sold_out"],
    ["confirmed", "not_yet", "not_yet"],
    ["announced", "not_yet", "not_yet"],
    ["expected", "not_yet", "not_yet"],
    ["announced", "open", "not_yet"],
    ["expected", "sold_out", "closed"],
    ["postponed", "open", "closed"],
    ["postponed", "not_yet", "closed"],
    ["postponed", "none", "none"],
    ["cancelled", "sold_out", "closed"],
    ["cancelled", "none", "none"],
    ["announced", "closed", "closed"],
  ];
  for (const [status, booking, saved] of cases) {
    test(`${status} with ${booking} is saved as ${saved}`, async () => {
      const catalogue = fakeCatalogue();
      const result = await catalogue.service.saveExperience(input({ status, booking }));
      assert.equal(result.experience.booking, saved);
      assert.equal(
        catalogue.warnings.some((warning) => warning.message.startsWith("Booking not allowed")),
        saved !== booking,
      );
    });
  }

  test("moving to postponed closes booking", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const result = await catalogue.service.saveExperience(input({ experienceId: id, status: "postponed" }));
    assert.equal(result.experience.status, "postponed");
    assert.equal(result.experience.booking, "closed");
  });

  test("a refused status move checks the booking against the status kept", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue, { status: "postponed", booking: "closed" });
    catalogue.set(id, { status: "postponed" });
    const result = await catalogue.service.saveExperience(input({ experienceId: id, status: "expected", booking: "open" }));
    assert.equal(result.experience.status, "postponed");
    assert.equal(result.experience.booking, "closed");
  });
});

describe("change kinds", () => {
  const moved = [{ startDate: "2027-03-20", precision: "day" as const, startTime: "18:00", endTime: "22:00" }];
  const cases: [string, Partial<SaveExperienceInput>, Partial<SaveExperienceInput>, string][] = [
    ["announced to confirmed", { status: "announced", booking: "not_yet" }, { status: "confirmed", booking: "not_yet" }, "confirmed"],
    ["expected to confirmed", { status: "expected", booking: "not_yet" }, { status: "confirmed", booking: "not_yet" }, "confirmed"],
    ["a session moved", {}, { sessions: moved }, "rescheduled"],
    ["a session's time moved", {}, { sessions: [{ startDate: "2027-03-13", precision: "day", startTime: "19:00" }] }, "rescheduled"],
    ["a session added", { type: "run" }, { type: "run", sessions: [...(input().sessions), ...moved] }, "rescheduled"],
    ["a session removed", { type: "run" }, { type: "run", sessions: [] }, "rescheduled"],
    [
      "postponed to new dates",
      { status: "postponed", booking: "closed" },
      { status: "confirmed", booking: "open", sessions: moved },
      "rescheduled",
    ],
    ["postponed to confirmed", { status: "postponed", booking: "closed" }, { status: "confirmed", booking: "open" }, "rescheduled"],
    ["to postponed", {}, { status: "postponed" }, "postponed"],
    ["to cancelled", {}, { status: "cancelled" }, "cancelled"],
    ["booking", {}, { booking: "sold_out" }, "changed"],
    ["a session sold out", {}, { sessions: [{ ...(input().sessions[0] ?? { startDate: "", precision: "day" }), soldOut: true }] }, "changed"],
    ["a tag", {}, { tags: ["jazz", "sunset"] }, "changed"],
    ["an attribute", {}, { attributes: { category: ["music"], audience: ["family"] } }, "changed"],
    ["cancelled with new dates", {}, { status: "cancelled", sessions: moved }, "cancelled"],
    ["postponed with new dates", {}, { status: "postponed", sessions: moved }, "postponed"],
    [
      "confirmed with new dates",
      { status: "announced", booking: "not_yet" },
      { status: "confirmed", sessions: moved },
      "rescheduled",
    ],
  ];
  for (const [name, before, after, kind] of cases) {
    test(`${name} is ${kind}`, async () => {
      const catalogue = fakeCatalogue();
      const id = await created(catalogue, before);
      const result = await catalogue.service.saveExperience(input({ ...before, ...after, experienceId: id }));
      assert.equal(result.change, kind);
      assert.equal(result.experience.version, 2);
      assert.equal(catalogue.writes[1]?.change?.kind, kind);
      assert.deepEqual(catalogue.publishedEvents(), [
        { type: "experience.published", resourceId: id, data: { version: 1, raw_listing_id: RAW_A } },
        { type: "experience.changed", resourceId: id, data: { version: 2, change: kind, raw_listing_id: RAW_A } },
      ]);
    });
  }
});

describe("removing a source link", () => {
  test("an experience left with no links is Removed, with booking Closed", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    const lost = await catalogue.service.removeSourceLink({ listingId: LISTING_A, rawListingId: RAW_B });
    assert.deepEqual(lost, [id]);
    const stored = catalogue.experiences.get(id);
    assert.equal(stored?.status, "removed");
    assert.equal(stored.booking, "closed");
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.listingIds, []);
    const write = catalogue.writes[1];
    assert.deepEqual(write?.change, {
      kind: "removed",
      previous: { status: "confirmed", booking: "open", listingIds: [LISTING_A] },
    });
    assert.deepEqual(write.event?.data, { version: 2, change: "removed", raw_listing_id: RAW_B });
    assert.deepEqual(catalogue.publishedEvents()[1], {
      type: "experience.changed",
      resourceId: id,
      data: { version: 2, change: "removed", raw_listing_id: RAW_B },
    });
    assert.equal(catalogue.published.length, 2);
  });

  test("an experience with links left keeps its status and gets a new version", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    await catalogue.service.saveExperience(
      input({ experienceId: id, source: { listingId: LISTING_B, rawListingId: RAW_B }, precedence: "fill" }),
    );
    await catalogue.service.removeSourceLink({ listingId: LISTING_A, experienceId: id, rawListingId: RAW_B });
    const stored = catalogue.experiences.get(id);
    assert.equal(stored?.status, "confirmed");
    assert.equal(stored.version, 3);
    assert.deepEqual(stored.listingIds, [LISTING_B]);
    assert.equal(catalogue.writes[2]?.change?.kind, "changed");
    assert.deepEqual(catalogue.publishedEvents(), [
      { type: "experience.published", resourceId: id, data: { version: 1, raw_listing_id: RAW_A } },
      { type: "experience.changed", resourceId: id, data: { version: 2, change: "changed", raw_listing_id: RAW_B } },
      { type: "experience.changed", resourceId: id, data: { version: 3, change: "changed", raw_listing_id: RAW_B } },
    ]);
  });

  for (const status of ["past", "cancelled"] as const) {
    test(`a ${status} experience keeps its status and gets no new version`, async () => {
      const catalogue = fakeCatalogue();
      const id = await created(catalogue, { booking: "none" });
      catalogue.set(id, { status });
      await catalogue.service.removeSourceLink({ listingId: LISTING_A, rawListingId: RAW_B });
      const stored = catalogue.experiences.get(id);
      assert.equal(stored?.status, status);
      assert.equal(stored.version, 1);
      assert.deepEqual(stored.listingIds, []);
      assert.equal(catalogue.writes[1]?.change, null);
      assert.equal(catalogue.writes[1].event, null);
      assert.equal(catalogue.published.length, 1);
    });
  }

  test("removes the link from only the experience named", async () => {
    const catalogue = fakeCatalogue();
    const first = await created(catalogue);
    const second = await created(catalogue, { title: "Sunset Jazz" });
    const lost = await catalogue.service.removeSourceLink({ listingId: LISTING_A, experienceId: second, rawListingId: RAW_B });
    assert.deepEqual(lost, [second]);
    assert.equal(catalogue.experiences.get(first)?.status, "confirmed");
    assert.equal(catalogue.experiences.get(second)?.status, "removed");
  });

  test("returns nothing when the listing links to nothing", async () => {
    const catalogue = fakeCatalogue();
    assert.deepEqual(await catalogue.service.removeSourceLink({ listingId: LISTING_B, rawListingId: RAW_B }), []);
    assert.equal(catalogue.writes.length, 0);
  });
});

describe("a reading of a listing that did not yield an experience", () => {
  // A listing that yields two experiences; the second is then missing from readings of it.
  async function twoFromOneListing(catalogue: ReturnType<typeof fakeCatalogue>) {
    const kept = await created(catalogue);
    const missing = await created(catalogue, { title: "Whale Walk", sessions: [{ startDate: "2027-07-01", precision: "day" }] });
    return { kept, missing };
  }
  const miss = (catalogue: ReturnType<typeof fakeCatalogue>, experienceId: string) =>
    catalogue.service.recordMissedReading({
      listingId: LISTING_A,
      experienceId,
      rawListingId: crypto.randomUUID(),
      missesBeforeRemoval: 3,
    });

  test("keeps the link and changes nothing for two readings, and removes it on the third", async () => {
    const catalogue = fakeCatalogue();
    const { missing } = await twoFromOneListing(catalogue);
    const writes = catalogue.writes.length;
    const published = catalogue.published.length;

    for (const reading of [1, 2]) {
      assert.equal(await miss(catalogue, missing), false, `reading ${String(reading)}`);
      const stored = catalogue.experiences.get(missing);
      assert.deepEqual([stored?.status, stored?.version, stored?.listingIds], ["confirmed", 1, [LISTING_A]]);
    }
    assert.equal(catalogue.writes.length, writes);
    assert.equal(catalogue.published.length, published);

    assert.equal(await miss(catalogue, missing), true);
    const gone = catalogue.experiences.get(missing);
    assert.deepEqual([gone?.status, gone?.version, gone?.listingIds], ["removed", 2, []]);
    assert.equal(catalogue.writes.at(-1)?.change?.kind, "removed");
    assert.equal(catalogue.published.length, published + 1);
  });

  test("a reading that yields it again sets the count back", async () => {
    const catalogue = fakeCatalogue();
    const { missing } = await twoFromOneListing(catalogue);
    await miss(catalogue, missing);
    await miss(catalogue, missing);
    // The listing yields it again, unchanged.
    const again = await catalogue.service.saveExperience(
      input({
        experienceId: missing,
        title: "Whale Walk",
        sessions: [{ startDate: "2027-07-01", precision: "day" }],
        source: { listingId: LISTING_A, rawListingId: RAW_B },
      }),
    );
    assert.equal(again.changed, false);
    assert.equal(await miss(catalogue, missing), false);
    assert.equal(await miss(catalogue, missing), false);
    assert.equal(catalogue.experiences.get(missing)?.status, "confirmed");
    assert.equal(await miss(catalogue, missing), true);
  });

  test("an experience with another listing keeps its status when the link goes", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    await catalogue.service.saveExperience(input({ experienceId: id, source: { listingId: LISTING_B, rawListingId: RAW_B }, precedence: "fill" }));
    for (let reading = 0; reading < 3; reading += 1) await miss(catalogue, id);
    const stored = catalogue.experiences.get(id);
    assert.deepEqual([stored?.status, stored?.listingIds], ["confirmed", [LISTING_B]]);
  });

  test("a listing that does not link to the experience counts nothing", async () => {
    const catalogue = fakeCatalogue();
    const id = await created(catalogue);
    assert.equal(
      await catalogue.service.recordMissedReading({
        listingId: LISTING_B,
        experienceId: id,
        rawListingId: RAW_B,
        missesBeforeRemoval: 1,
      }),
      false,
    );
    assert.deepEqual(catalogue.experiences.get(id)?.listingIds, [LISTING_A]);
  });
});

describe("finding experiences by listing", () => {
  test("returns every experience the listing links to, whatever its status", async () => {
    const catalogue = fakeCatalogue();
    const first = await created(catalogue);
    const second = await created(catalogue, { title: "Sunset Jazz", type: "run", sessions: [
      { startDate: "2027-04-01", precision: "day" },
      { startDate: "2027-04-08", endDate: "2027-04-09", precision: "day" },
    ] });
    catalogue.set(second, { status: "cancelled" });
    const matches = await catalogue.service.findExperiencesByListing(LISTING_A);
    assert.deepEqual(
      matches.map((match) => [match.id, match.status, match.firstDate, match.lastDate, match.sessions.length]),
      [
        [first, "confirmed", "2027-03-13", "2027-03-13", 1],
        [second, "cancelled", "2027-04-01", "2027-04-09", 2],
      ],
    );
    assert.deepEqual(matches[0]?.listingIds, [LISTING_A]);
    assert.equal(matches[0].venueName, "Gearing's Point");
    assert.equal(matches[0].city, "Hermanus");
  });
});
