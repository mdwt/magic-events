import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { events, experience, experienceChange, experienceSession } from "@magic-events/db";
import { asc, count, eq, inArray, max } from "drizzle-orm";
import { createDomainEvents } from "../src/adapters/events/node-events.ts";
import { createLogger } from "../src/adapters/logging/pino.ts";
import type { Catalogue, SaveExperienceInput } from "../src/core/catalogue/ports.ts";
import type { DomainEvent } from "../src/core/shared/domain-events.ts";
import { input as listing } from "./helpers/catalogue-fake.ts";
import { createHarness, testSettings, type Harness } from "./helpers/harness.ts";

// Catalogue's upkeep against the database, end to end: the experiences are saved on 1 December 2026, and the upkeep
// runs at 00:30 on 11 December in Hermanus.

const clock = { now: new Date("2026-12-01T10:00:00.000Z") };
const domainEvents = createDomainEvents(createLogger(testSettings(process.env.TEST_DATABASE_URL ?? "").api));
const received: DomainEvent[] = [];
domainEvents.subscribe("*", (event) => {
  received.push(event);
});

let harness: Harness;
let catalogue: Catalogue;
let locationId: string;
const ids = { over: "", closing: "", market: "" };

async function create(overrides: Partial<SaveExperienceInput>): Promise<string> {
  const { experience: saved } = await catalogue.saveExperience(
    listing({ locationId, source: { listingId: randomUUID(), rawListingId: randomUUID() }, ...overrides }),
  );
  return saved.id;
}

async function lastSession(experienceId: string) {
  const [row] = await harness.db
    .select({ last: max(experienceSession.startDate), total: count() })
    .from(experienceSession)
    .where(eq(experienceSession.experienceId, experienceId));
  return row;
}

before(async () => {
  harness = await createHarness({ domainEvents, clock: () => clock.now });
  catalogue = harness.services.catalogue;
  const hermanus = await catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
  locationId = hermanus.id;
  ids.over = await create({
    title: "Jazz on 10 December",
    bookingClosesAt: undefined,
    sessions: [{ startDate: "2026-12-10", precision: "day", startTime: "18:00", endTime: "22:00" }],
  });
  ids.closing = await create({
    title: "Winter Jazz",
    bookingClosesAt: "2026-12-05T10:00:00.000Z",
    sessions: [{ startDate: "2027-06-12", precision: "day" }],
  });
  ids.market = await create({
    title: "Hermanus Country Market",
    type: "recurring",
    booking: "none",
    bookingClosesAt: undefined,
    sessions: [],
    recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-28", startTime: "09:00", endTime: "13:00" },
  });
});

after(async () => {
  await harness.close();
});

describe("keeping the catalogue up", () => {
  test("sets the finished experience to Past, closes the booking and generates the market further ahead", async () => {
    assert.deepEqual(await lastSession(ids.market), { last: "2028-11-25", total: 104 });
    received.length = 0;

    clock.now = new Date("2026-12-10T22:30:00.000Z");
    // The horizon is now 11 December 2028: two more Saturdays.
    assert.deepEqual(await catalogue.keepUp(), { past: 1, bookingsClosed: 1, sessionsGenerated: 2 });

    const rows = await harness.db
      .select({ id: experience.id, status: experience.status, booking: experience.booking, version: experience.version })
      .from(experience)
      .where(inArray(experience.id, [ids.over, ids.closing, ids.market]));
    const byId = new Map(rows.map((row) => [row.id, [row.status, row.booking, row.version]]));
    assert.deepEqual(byId.get(ids.over), ["past", "closed", 2]);
    assert.deepEqual(byId.get(ids.closing), ["confirmed", "closed", 2]);
    assert.deepEqual(byId.get(ids.market), ["confirmed", "none", 1]);

    const changes = await harness.db
      .select({ id: experienceChange.experienceId, version: experienceChange.version, kind: experienceChange.kind })
      .from(experienceChange)
      .orderBy(asc(experienceChange.changedAt), asc(experienceChange.version));
    const kinds = (id: string) => changes.filter((row) => row.id === id).map((row) => [row.version, row.kind]);
    assert.deepEqual(kinds(ids.over), [
      [1, "new"],
      [2, "past"],
    ]);
    assert.deepEqual(kinds(ids.closing), [
      [1, "new"],
      [2, "changed"],
    ]);
    assert.deepEqual(kinds(ids.market), [[1, "new"]]);

    const logged = await harness.db
      .select({ id: events.resourceId, type: events.type, data: events.data })
      .from(events)
      .where(eq(events.type, "experience.changed"));
    const expected = [
      { id: ids.over, type: "experience.changed", data: { version: 2, change: "past" } },
      { id: ids.closing, type: "experience.changed", data: { version: 2, change: "changed" } },
    ];
    const byResource = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    assert.deepEqual(logged.sort(byResource), [...expected].sort(byResource));
    assert.deepEqual(
      received.map(({ resourceId, type, data }) => ({ id: resourceId, type, data })).sort(byResource),
      [...expected].sort(byResource),
    );

    assert.deepEqual(await lastSession(ids.market), { last: "2028-12-09", total: 106 });
  });

  test("a second run on the same day finds nothing to do", async () => {
    received.length = 0;
    assert.deepEqual(await catalogue.keepUp(), { past: 0, bookingsClosed: 0, sessionsGenerated: 0 });
    assert.deepEqual(received, []);
  });
});
