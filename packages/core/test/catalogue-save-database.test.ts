import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { events, experience, experienceChange, experienceSession, experienceSourceLink } from "@magic-events/db";
import { count, eq, sql } from "drizzle-orm";
import { createDomainEvents } from "../src/adapters/events/node-events.ts";
import { createLogger } from "../src/adapters/logging/pino.ts";
import { createCatalogueRepository } from "../src/adapters/storage/catalogue-repository.ts";
import { createTransactionalDb } from "../src/adapters/storage/transactions.ts";
import type { Catalogue, Location, SaveExperienceInput } from "../src/catalogue/ports.ts";
import { CatalogueService } from "../src/catalogue/service.ts";
import type { DomainEvent } from "../src/shared/domain-events.ts";
import { input as listing, LISTING_A, LISTING_B, RAW_A, RAW_B } from "../src/testing/catalogue-fake.ts";
import { FakeEmbeddingModel } from "../src/testing/fake-embedding-model.ts";
import { createHarness, testSettings, type Harness } from "../src/testing/harness.ts";

// Saving experiences against the database. Today is 23 November 2026.

const NOW = new Date("2026-11-23T10:00:00.000Z");

let harness: Harness;
let catalogue: Catalogue;
let hermanus: Location;
// The domain events delivered to a subscriber of every type, since the test began.
const domainEvents = createDomainEvents(createLogger(testSettings(process.env.TEST_DATABASE_URL ?? "").api));
const received: DomainEvent[] = [];
domainEvents.subscribe("*", (event) => {
  received.push(event);
});

function input(overrides: Partial<SaveExperienceInput> = {}): SaveExperienceInput {
  return listing({ locationId: hermanus.id, ...overrides });
}

async function rows(experienceId: string) {
  const [changes, logged, links] = await Promise.all([
    harness.db.select().from(experienceChange).where(eq(experienceChange.experienceId, experienceId)),
    harness.db.select().from(events).where(eq(events.resourceId, experienceId)),
    harness.db.select().from(experienceSourceLink).where(eq(experienceSourceLink.experienceId, experienceId)),
  ]);
  return { changes, events: logged, links };
}

async function total(table: typeof experience | typeof events | typeof experienceSession): Promise<number> {
  const [counted] = await harness.db.select({ total: count() }).from(table);
  return counted?.total ?? 0;
}

before(async () => {
  harness = await createHarness({ domainEvents, clock: () => NOW });
  catalogue = harness.services.catalogue;
});

beforeEach(async () => {
  await harness.db.execute(sql`truncate table experience, events, location cascade`);
  received.length = 0;
  hermanus = await catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
});

after(async () => {
  await harness.close();
});

describe("saving an experience", () => {
  test("a created experience is found by search and loads as it was saved", async () => {
    const result = await catalogue.saveExperience(input());
    const found = await catalogue.searchExperiences({
      near: { lat: -34.4187, lng: 19.2345 },
      from: "2027-03-10",
      to: "2027-03-20",
      query: "jazz",
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(
      found.items.map((item) => [item.id, item.slug, item.bookable, item.sessions.length]),
      [[result.experience.id, "jazz-on-the-cliffs", true, 1]],
    );
    assert.deepEqual(found.items[0]?.attributes, { audience: ["adults"], category: ["music"] });
    assert.equal(found.items[0].pageUrl, "https://whatson.example.com/jazz-on-the-cliffs");
    assert.deepEqual(found.items[0].venue.position, { lat: -34.42, lng: 19.24 });

    const [loaded] = await catalogue.findExperiencesByListing(LISTING_A);
    assert.equal(loaded?.id, result.experience.id);

    const written = await rows(result.experience.id);
    assert.deepEqual(
      written.changes.map((change) => [change.version, change.kind, change.previous, change.changedAt.toISOString()]),
      [[1, "new", null, NOW.toISOString()]],
    );
    assert.deepEqual(
      written.events.map((event) => [event.type, event.data]),
      [["experience.published", { version: 1, raw_listing_id: RAW_A }]],
    );
    assert.deepEqual(
      written.links.map((link) => link.listingId),
      [LISTING_A],
    );

    // Saving the same listing again reads back exactly what was stored, so it is no change.
    const again = await catalogue.saveExperience(input({ experienceId: result.experience.id }));
    assert.equal(again.changed, false);
    assert.deepEqual(again.experience, result.experience);
  });

  test("a free experience keeps its price of 0 and 0 through a save and a search", async () => {
    const free = { min: 0, max: 0, currency: "ZAR" };
    const result = await catalogue.saveExperience(input({ price: free }));
    assert.deepEqual(result.experience.price, free);

    const found = await catalogue.searchExperiences({
      near: { lat: -34.4187, lng: 19.2345 },
      from: "2027-03-10",
      to: "2027-03-20",
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(found.items[0]?.price, free);

    // Saving it again is no change: the 0 read back equals the 0 saved.
    const again = await catalogue.saveExperience(input({ experienceId: result.experience.id, price: free }));
    assert.equal(again.changed, false);
  });

  test("an update bumps the version once, with one change row and one domain event", async () => {
    const { experience: saved } = await catalogue.saveExperience(input());
    const result = await catalogue.saveExperience(
      input({
        experienceId: saved.id,
        status: "postponed",
        source: { listingId: LISTING_A, rawListingId: RAW_B },
      }),
    );
    assert.equal(result.change, "postponed");

    const [stored] = await harness.db.select().from(experience).where(eq(experience.id, saved.id));
    assert.equal(stored?.version, 2);
    assert.equal(stored.status, "postponed");
    assert.equal(stored.booking, "closed");
    const written = await rows(saved.id);
    assert.deepEqual(
      written.changes.map((change) => [change.version, change.kind, change.previous]).sort(),
      [
        [1, "new", null],
        [2, "postponed", { status: "confirmed", booking: "open" }],
      ],
    );
    assert.deepEqual(
      written.events.map((event) => [event.type, event.data]).sort(),
      [
        ["experience.changed", { version: 2, change: "postponed", raw_listing_id: RAW_B }],
        ["experience.published", { version: 1, raw_listing_id: RAW_A }],
      ],
    );
  });

  test("an update that changes nothing writes nothing", async () => {
    const { experience: saved } = await catalogue.saveExperience(input());
    const before = await rows(saved.id);
    const result = await catalogue.saveExperience(input({ experienceId: saved.id }));
    assert.equal(result.changed, false);
    const afterwards = await rows(saved.id);
    assert.equal(afterwards.changes.length, before.changes.length);
    assert.equal(afterwards.events.length, before.events.length);
  });

  test("a change to the profile clears the embedding and makes no version", async () => {
    const { experience: saved } = await catalogue.saveExperience(input());
    const embedding = Array.from({ length: 1024 }, () => 0.01);
    await harness.db
      .update(experience)
      .set({ embedding, embeddingModel: "test-model" })
      .where(eq(experience.id, saved.id));

    await catalogue.saveExperience(input({ experienceId: saved.id, imageUrl: "https://tickets.example.com/new.jpg" }));
    const [kept] = await harness.db.select().from(experience).where(eq(experience.id, saved.id));
    assert.equal(kept?.embeddingModel, "test-model");

    await catalogue.saveExperience(
      input({ experienceId: saved.id, imageUrl: "https://tickets.example.com/new.jpg", profile: "Reworded." }),
    );
    const [cleared] = await harness.db.select().from(experience).where(eq(experience.id, saved.id));
    assert.equal(cleared?.embedding, null);
    assert.equal(cleared.embeddingModel, null);
    assert.equal(cleared.profile, "Reworded.");
    assert.equal(cleared.version, 2);
  });

  test("a second listing with fill only fills", async () => {
    const { experience: saved } = await catalogue.saveExperience(input({ summary: undefined }));
    const result = await catalogue.saveExperience(
      input({
        experienceId: saved.id,
        title: "Jazz at the Cliffs",
        summary: "Filled from the second listing.",
        status: "cancelled",
        sessions: [{ startDate: "2027-04-01", precision: "day" }],
        tags: ["festival"],
        source: { listingId: LISTING_B, rawListingId: RAW_B },
        precedence: "fill",
      }),
    );
    assert.equal(result.change, "changed");
    const [loaded] = await catalogue.findExperiencesByListing(LISTING_B);
    assert.equal(loaded?.title, "Jazz on the Cliffs");
    assert.equal(loaded.status, "confirmed");
    assert.deepEqual(loaded.sessions, [{ startDate: "2027-03-13", endDate: "2027-03-13" }]);
    assert.deepEqual([...loaded.listingIds].sort(), [LISTING_A, LISTING_B].sort());
    assert.equal(result.experience.summary, "Filled from the second listing.");
    // Its tags are added to the stored ones, as its attribute keys are.
    assert.deepEqual(result.experience.tags, ["festival", "jazz"]);
  });

  test("a recurring experience stores its recurrence and generated sessions", async () => {
    const result = await catalogue.saveExperience(
      input({
        title: "Hermanus Country Market",
        type: "recurring",
        booking: "none",
        sessions: [{ startDate: "2026-12-23", precision: "day", startTime: "17:00" }],
        recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01", startTime: "08:30", skipped: ["2026-12-26"] },
      }),
    );
    const again = await catalogue.saveExperience(
      input({
        experienceId: result.experience.id,
        title: "Hermanus Country Market",
        type: "recurring",
        booking: "none",
        sessions: [{ startDate: "2026-12-23", precision: "day", startTime: "17:00" }],
        recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01", startTime: "08:30", skipped: ["2026-12-26"] },
      }),
    );
    assert.equal(again.changed, false);
    assert.deepEqual(again.experience, result.experience);
    assert.equal(result.experience.sessions.length, 104);
    assert.equal(await total(experienceSession), 104);
  });
});

describe("publishing domain events", () => {
  test("a create then an update deliver experience.published then experience.changed, as stored", async () => {
    const { experience: saved } = await catalogue.saveExperience(input());
    await catalogue.saveExperience(
      input({ experienceId: saved.id, status: "cancelled", source: { listingId: LISTING_A, rawListingId: RAW_B } }),
    );
    // A save that makes no version publishes nothing.
    await catalogue.saveExperience(
      input({ experienceId: saved.id, status: "cancelled", source: { listingId: LISTING_A, rawListingId: RAW_B } }),
    );

    assert.deepEqual(
      received.map((event) => [event.type, event.resourceId, event.data]),
      [
        ["experience.published", saved.id, { version: 1, raw_listing_id: RAW_A }],
        ["experience.changed", saved.id, { version: 2, change: "cancelled", raw_listing_id: RAW_B }],
      ],
    );
    const logged = await harness.db.select().from(events).where(eq(events.resourceId, saved.id));
    const stored = logged
      .map((row) => ({
        id: row.id,
        type: row.type,
        resourceId: row.resourceId,
        data: row.data,
        recordedAt: row.recordedAt.toISOString(),
      }))
      .sort((a, b) => a.type.localeCompare(b.type))
      .reverse();
    assert.deepEqual(received, stored);
  });

  test("removing the last link delivers the move to Removed", async () => {
    const { experience: saved } = await catalogue.saveExperience(input());
    await catalogue.removeSourceLink({ listingId: LISTING_A, rawListingId: RAW_B });
    assert.deepEqual(received.at(-1)?.data, { version: 2, change: "removed", raw_listing_id: RAW_B });
    assert.equal(received.at(-1)?.resourceId, saved.id);
    assert.equal(received.length, 2);
  });
});

describe("removing source links", () => {
  test("removing the last link sets Removed", async () => {
    const { experience: saved } = await catalogue.saveExperience(input());
    assert.deepEqual(await catalogue.removeSourceLink({ listingId: LISTING_A, rawListingId: RAW_B }), [saved.id]);
    const [stored] = await harness.db.select().from(experience).where(eq(experience.id, saved.id));
    assert.equal(stored?.status, "removed");
    assert.equal(stored.booking, "closed");
    assert.equal(stored.version, 2);
    const written = await rows(saved.id);
    assert.deepEqual(written.links, []);
    assert.ok(written.changes.some((change) => change.version === 2 && change.kind === "removed"));
    assert.ok(
      written.events.some(
        (event) => event.type === "experience.changed" && event.data.change === "removed" && event.data.raw_listing_id === RAW_B,
      ),
    );
  });

  test("removing one of two links keeps the experience", async () => {
    const { experience: saved } = await catalogue.saveExperience(input());
    await catalogue.saveExperience(
      input({ experienceId: saved.id, source: { listingId: LISTING_B, rawListingId: RAW_B }, precedence: "fill" }),
    );
    await catalogue.removeSourceLink({ listingId: LISTING_A, rawListingId: RAW_B });
    const [loaded] = await catalogue.findExperiencesByListing(LISTING_B);
    assert.equal(loaded?.status, "confirmed");
    assert.deepEqual(loaded.listingIds, [LISTING_B]);
    assert.deepEqual(await catalogue.findExperiencesByListing(LISTING_A), []);
    const [stored] = await harness.db.select().from(experience).where(eq(experience.id, saved.id));
    assert.equal(stored?.version, 3);
  });

  for (const status of ["past", "cancelled"] as const) {
    test(`a ${status} experience keeps its status`, async () => {
      const { experience: saved } = await catalogue.saveExperience(input());
      await harness.db.update(experience).set({ status }).where(eq(experience.id, saved.id));
      await catalogue.removeSourceLink({ listingId: LISTING_A, rawListingId: RAW_B });
      const [stored] = await harness.db.select().from(experience).where(eq(experience.id, saved.id));
      assert.equal(stored?.status, status);
      assert.equal(stored.version, 1);
      const written = await rows(saved.id);
      assert.deepEqual(written.links, []);
      assert.equal(written.changes.length, 1);
      assert.equal(written.events.length, 1);
    });
  }
});

describe("in a surrounding transaction", () => {
  test("everything a save writes is rolled back when the transaction fails", async () => {
    // A service set like the one app.ts builds, with the transactions handle in reach.
    const settings = testSettings(process.env.TEST_DATABASE_URL ?? "");
    const transactional = createTransactionalDb(harness.db);
    const { db, transactions } = transactional;
    const service = new CatalogueService({
      repository: createCatalogueRepository(db),
      // Published as app.ts does: once the surrounding transaction commits.
      events: {
        publish(event) {
          transactional.afterCommit(() => {
            domainEvents.publish(event);
          });
        },
      },
      dataProcessing: harness.services.dataProcessing,
      settings: settings.catalogue,
      embeddings: new FakeEmbeddingModel(),
      embeddingSettings: settings.embedding,
      logger: createLogger(settings.api),
      clock: () => NOW,
    });
    const { experience: kept } = await service.saveExperience(input({ title: "Kept" }));
    assert.deepEqual(
      received.map((event) => [event.type, event.resourceId]),
      [["experience.published", kept.id]],
    );

    await assert.rejects(
      transactions.run(async () => {
        await service.saveExperience(input({ title: "Rolled back" }));
        await service.saveExperience(
          input({ experienceId: kept.id, title: "Kept, renamed", source: { listingId: LISTING_B, rawListingId: RAW_B } }),
        );
        await service.removeSourceLink({ listingId: LISTING_A, experienceId: kept.id, rawListingId: RAW_B });
        throw new Error("the processing failed");
      }),
      /the processing failed/,
    );

    assert.equal(await total(experience), 1);
    assert.equal(await total(events), 1);
    assert.equal(await total(experienceSession), 1);
    const [stored] = await harness.db.select().from(experience).where(eq(experience.id, kept.id));
    assert.equal(stored?.title, "Kept");
    assert.equal(stored.version, 1);
    const written = await rows(kept.id);
    assert.deepEqual(
      written.links.map((link) => link.listingId),
      [LISTING_A],
    );
    assert.equal(written.changes.length, 1);
    // Nothing that was rolled back was delivered.
    assert.equal(received.length, 1);
  });

  test("a save worked out from a version that has since moved on fails", async () => {
    const repository = createCatalogueRepository(harness.db);
    const { experience: saved } = await catalogue.saveExperience(input());
    const [stored] = await repository.loadExperiences({ ids: [saved.id] });
    assert.ok(stored);
    await catalogue.saveExperience(input({ experienceId: saved.id, title: "Renamed" }));
    await assert.rejects(
      repository.saveExperiences([
        {
          experience: { ...stored, title: "Stale", version: 2 },
          previousVersion: 1,
          replace: { sessions: false, attributes: false, tags: false },
          links: { add: [], remove: [] },
          clearEmbedding: false,
          change: { kind: "changed", previous: {} },
          event: null,
          at: NOW,
        },
      ]),
      /no longer at version 1/,
    );
  });
});
