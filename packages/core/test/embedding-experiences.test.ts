import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { events, experience, experienceChange } from "@magic-events/db";
import { asc, count, eq } from "drizzle-orm";
import { createLogger } from "../src/adapters/logging/pino.ts";
import { createServices } from "../src/services.ts";
import type { Catalogue, EmbeddingModel } from "../src/catalogue/ports.ts";
import { input as listing } from "../src/testing/catalogue-fake.ts";
import { insertExperienceFixture } from "../src/testing/experience-fixture.ts";
import { FakeEmbeddingModel, point } from "../src/testing/fake-embedding-model.ts";
import { createHarness, testSettings, type Harness } from "../src/testing/harness.ts";

// Catalogue's embedding against the database: what is due, what is stored, and what is left as it is.

let harness: Harness;
let catalogue: Catalogue;
let locationId: string;
const model = new FakeEmbeddingModel({ model: "titan-test" });

// The same database with another embedding model, as after a change of the embedding settings.
function catalogueWith(embeddingModel: EmbeddingModel): Catalogue {
  const settings = testSettings(process.env.TEST_DATABASE_URL ?? "");
  return createServices({
    settings,
    db: harness.db,
    logger: createLogger(settings.api),
    overrides: { embeddingModel },
  }).catalogue;
}

async function rows() {
  return harness.db
    .select({
      title: experience.title,
      status: experience.status,
      embedding: experience.embedding,
      embeddingModel: experience.embeddingModel,
      version: experience.version,
      updatedAt: experience.updatedAt,
    })
    .from(experience)
    .orderBy(asc(experience.title));
}

async function counts() {
  const [changes] = await harness.db.select({ total: count() }).from(experienceChange);
  const [appended] = await harness.db.select({ total: count() }).from(events);
  return { changes: changes?.total, events: appended?.total };
}

before(async () => {
  harness = await createHarness({ embeddingModel: model });
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
  const statuses = ["expected", "announced", "confirmed", "postponed", "cancelled", "removed", "past"] as const;
  for (const status of statuses) {
    await insertExperienceFixture(harness.db, {
      locationId,
      title: `A ${status} experience`,
      status,
      ...(status === "postponed" ? {} : { profile: `What the ${status} one is about.` }),
      sessions: [{ startDate: "2027-06-12" }],
    });
  }
});

after(async () => {
  await harness.close();
});

describe("embedding experiences", () => {
  test("embeds the experiences search can return, and skips Cancelled, Removed and Past", async () => {
    const before = await counts();
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 4, failed: 0, setAside: 0, remaining: 0 });

    assert.deepEqual(
      [...model.documents()].sort(),
      [
        "A announced experience\nWhat the announced one is about.",
        "A confirmed experience\nWhat the confirmed one is about.",
        "A expected experience\nWhat the expected one is about.",
        // No profile: the title alone.
        "A postponed experience",
      ],
    );
    const stored = await rows();
    for (const row of stored) {
      const searchable = ["expected", "announced", "confirmed", "postponed"].includes(row.status);
      assert.equal(row.embeddingModel, searchable ? "titan-test" : null, row.title);
      assert.equal(row.embedding?.length, searchable ? 1024 : undefined, row.title);
    }
    const confirmed = stored.find((row) => row.status === "confirmed");
    assert.deepEqual(
      confirmed?.embedding?.map((value) => Math.round(value * 1e6)),
      (await model.embed(["A confirmed experience\nWhat the confirmed one is about."], "document"))[0]?.map((value) =>
        Math.round(value * 1e6),
      ),
    );
    // Storing an embedding is not a change: no version, no update time, no change row, no domain event.
    assert.ok(stored.every((row) => row.version === 1));
    assert.deepEqual(await counts(), before);
  });

  test("a round with nothing due asks the model nothing", async () => {
    const calls = model.calls.length;
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 0, failed: 0, setAside: 0, remaining: 0 });
    assert.equal(model.calls.length, calls);
  });

  test("the update time is left as it was", async () => {
    const before = await rows();
    await harness.db
      .update(experience)
      .set({ embedding: null, embeddingModel: null })
      .where(eq(experience.title, "A confirmed experience"));
    await catalogue.embedExperiences();
    assert.deepEqual(
      (await rows()).map((row) => [row.title, row.updatedAt.toISOString(), row.version]),
      before.map((row) => [row.title, row.updatedAt.toISOString(), row.version]),
    );
  });

  test("embeds again after a title change cleared the embedding", async () => {
    // What a save does when the title changes.
    await harness.db
      .update(experience)
      .set({ title: "A confirmed experience, renamed", embedding: null, embeddingModel: null })
      .where(eq(experience.title, "A confirmed experience"));

    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 1, failed: 0, setAside: 0, remaining: 0 });
    assert.equal(model.documents().at(-1), "A confirmed experience, renamed\nWhat the confirmed one is about.");
    const [renamed] = await harness.db
      .select({ model: experience.embeddingModel })
      .from(experience)
      .where(eq(experience.title, "A confirmed experience, renamed"));
    assert.equal(renamed?.model, "titan-test");
  });

  test("an embedding made from a title that changed meanwhile is not stored, and stays due", async () => {
    await harness.db
      .update(experience)
      .set({ embedding: null, embeddingModel: null })
      .where(eq(experience.title, "A expected experience"));
    // The title changes while the model works on the old one.
    const racing: EmbeddingModel = {
      model: "titan-test",
      dimensions: 1024,
      async embed(texts) {
        await harness.db
          .update(experience)
          .set({ title: "A expected experience, renamed" })
          .where(eq(experience.title, "A expected experience"));
        return texts.map(() => point([1]));
      },
    };
    assert.deepEqual(await catalogueWith(racing).embedExperiences(), { embedded: 0, failed: 0, setAside: 0, remaining: 1 });
    const [renamed] = await harness.db
      .select({ embedding: experience.embedding })
      .from(experience)
      .where(eq(experience.title, "A expected experience, renamed"));
    assert.equal(renamed?.embedding, null);

    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 1, failed: 0, setAside: 0, remaining: 0 });
  });

  test("a text the model fails on is counted and left for the next round", async () => {
    await harness.db
      .update(experience)
      .set({ embedding: null, embeddingModel: null })
      .where(eq(experience.status, "announced"));
    model.failOn = (text) => text.startsWith("A announced");
    try {
      assert.deepEqual(await catalogue.embedExperiences(), { embedded: 0, failed: 1, setAside: 0, remaining: 1 });
    } finally {
      model.failOn = () => false;
    }
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 1, failed: 0, setAside: 0, remaining: 0 });
    // A stored embedding clears the count.
    const [announced] = await harness.db
      .select({ failures: experience.embeddingFailures })
      .from(experience)
      .where(eq(experience.status, "announced"));
    assert.equal(announced?.failures, 0);
  });

  test("a change of model embeds every searchable experience again, and only search's statuses", async () => {
    const next = new FakeEmbeddingModel({ model: "titan-test-2" });
    const before = await counts();
    assert.deepEqual(await catalogueWith(next).embedExperiences(), { embedded: 4, failed: 0, setAside: 0, remaining: 0 });
    assert.equal(next.documents().length, 4);

    const stored = await rows();
    assert.deepEqual(
      stored.filter((row) => row.embeddingModel !== null).map((row) => row.embeddingModel),
      ["titan-test-2", "titan-test-2", "titan-test-2", "titan-test-2"],
    );
    assert.deepEqual(await counts(), before);
    // For the first model, everything is due again.
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 4, failed: 0, setAside: 0, remaining: 0 });
  });

  test("a text the model keeps failing on is set aside, still searched by keyword, and due again once its title changes", async () => {
    const recital = listing({
      locationId,
      title: "Refused Recital",
      sessions: [{ startDate: "2027-06-12", precision: "day" }],
    });
    const saved = await catalogue.saveExperience(recital);
    const id = saved.experience.id;
    model.failOn = (text) => text.startsWith("Refused Recital");
    try {
      // The default is three attempts.
      for (const setAside of [0, 0, 1]) {
        assert.deepEqual(await catalogue.embedExperiences(), { embedded: 0, failed: 1, setAside, remaining: 1 - setAside });
      }
      assert.deepEqual(await catalogue.embedExperiences(), { embedded: 0, failed: 0, setAside: 0, remaining: 0 });
    } finally {
      model.failOn = () => false;
    }
    const [aside] = await harness.db
      .select({ failures: experience.embeddingFailures, embedding: experience.embedding })
      .from(experience)
      .where(eq(experience.id, id));
    assert.deepEqual([aside?.failures, aside?.embedding], [3, null]);

    const found = await catalogue.searchExperiences({
      near: { lat: -34.4187, lng: 19.2345 },
      from: "2027-06-12",
      to: "2027-06-12",
      query: "recital",
      limit: 20,
      offset: 0,
    });
    assert.ok(found.items.some((item) => item.id === id));

    // A new title clears the count with the embedding, so it is tried again.
    await catalogue.saveExperience({ ...recital, experienceId: id, title: "Recital on the Cliffs" });
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 1, failed: 0, setAside: 0, remaining: 0 });
    assert.equal(model.documents().at(-1)?.startsWith("Recital on the Cliffs"), true);
  });
});
