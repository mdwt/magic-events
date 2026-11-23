import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { experience } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { Catalogue, SearchExperiencesInput, SearchExperiencesResult } from "../src/catalogue/ports.ts";
import { insertExperienceFixture, type ExperienceFixture } from "../src/testing/experience-fixture.ts";
import { FakeEmbeddingModel, point } from "../src/testing/fake-embedding-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Search with a query text against the database: the semantic list and the keyword list, combined by reciprocal
// rank fusion. The embedding model is a fake whose table puts each text at a point the test chooses, so the test
// knows which experience is nearest to which query.

const HERMANUS = { lat: -34.4187, lng: 19.2345 };

// Near the query by meaning, without any of the query's words.
const WALK = {
  title: "Sunset Cliff Walk",
  profile: "A gentle walk along the cliff path as the sun goes down, for two.",
  date: "2027-06-18",
};
// The query's words, far from it by meaning.
const CONCERT = { title: "Romantic Evening Concert", profile: "Love songs by candlelight in the church.", date: "2027-06-12" };
// Both: the query's words, often, and near it by meaning.
const CRUISE = {
  title: "Romantic Evening Cruise",
  profile: "A romantic evening on the water, a romantic evening for two.",
  date: "2027-06-15",
};
const SALE = { title: "Car Boot Sale", profile: "Second-hand goods in the school grounds.", date: "2027-06-10" };
// Has no embedding at all, so it is in neither list for a query with none of its words.
const RECITAL = { title: "Organ Recital", profile: "Bach on the church organ.", date: "2027-06-11" };
// One of the query's words, and an embedding from another model that sits right on the query.
const GALLERY = { title: "Romantic Gallery Night", profile: "Paintings and wine.", date: "2027-06-13" };

const ALL = [SALE, RECITAL, CONCERT, GALLERY, CRUISE, WALK];
const BY_DATE = ALL.map((one) => one.title);

const MEANING_ONLY = "a quiet stroll at dusk";
const WORDS_AND_MEANING = "romantic evening";

const text = (one: { title: string; profile: string }) => `${one.title}\n${one.profile}`;

const model = new FakeEmbeddingModel({
  model: "titan-test",
  table: {
    [MEANING_ONLY]: [1, 0],
    [WORDS_AND_MEANING]: [1, 0],
    [text(WALK)]: [1, 0],
    [text(CRUISE)]: [0.95, 0.05],
    [text(CONCERT)]: [0, 1],
    [text(SALE)]: [0, 0, 1],
    [text(RECITAL)]: [0, 0, 0, 1],
    [text(GALLERY)]: [0, 0, 0, 0, 1],
  },
});

let harness: Harness;
let catalogue: Catalogue;

function search(input: Partial<SearchExperiencesInput> = {}): Promise<SearchExperiencesResult> {
  return catalogue.searchExperiences({ near: HERMANUS, from: "2027-06-10", to: "2027-06-20", limit: 20, offset: 0, ...input });
}

async function titles(input: Partial<SearchExperiencesInput> = {}): Promise<string[]> {
  return (await search(input)).items.map((item) => item.title);
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
    latitude: HERMANUS.lat,
    longitude: HERMANUS.lng,
  });
  const fixtures: ExperienceFixture[] = ALL.map((one) => ({
    locationId: hermanus.id,
    title: one.title,
    profile: one.profile,
    sessions: [{ startDate: one.date }],
  }));
  // One outside the dates, which the query text must not bring in.
  fixtures.push({
    locationId: hermanus.id,
    title: "Romantic Evening in July",
    profile: WALK.profile,
    sessions: [{ startDate: "2027-07-10" }],
  });
  for (const fixture of fixtures) await insertExperienceFixture(harness.db, fixture);

  assert.deepEqual(await catalogue.embedExperiences(), { embedded: 7, failed: 0, setAside: 0, remaining: 0 });
  // The recital loses its embedding, and the gallery's is from another model, right on the query.
  await harness.db
    .update(experience)
    .set({ embedding: null, embeddingModel: null })
    .where(eq(experience.title, RECITAL.title));
  await harness.db
    .update(experience)
    .set({ embedding: point([1, 0]), embeddingModel: "another-model" })
    .where(eq(experience.title, GALLERY.title));
});

after(async () => {
  await harness.close();
});

describe("search with a query text, by meaning and by keyword", () => {
  test("without a query text the order is by date", async () => {
    assert.deepEqual(await titles(), BY_DATE);
  });

  test("an experience near the query by meaning, without its words, comes first by the semantic list", async () => {
    const found = await titles({ query: MEANING_ONLY });
    assert.deepEqual(found.slice(0, 2), [WALK.title, CRUISE.title]);
    // The two in neither list, by date: the one with no embedding, and the one from another model.
    assert.deepEqual(found.slice(-2), [RECITAL.title, GALLERY.title]);
  });

  test("one in both lists comes first, and one matching by keyword only still comes back", async () => {
    const found = await titles({ query: WORDS_AND_MEANING });
    assert.equal(found[0], CRUISE.title);
    // Far by meaning, but second by its words.
    assert.equal(found[1], CONCERT.title);
    // In the keyword list alone: its embedding is from another model, so it is not compared.
    assert.ok(found.indexOf(GALLERY.title) < found.indexOf(RECITAL.title));
    assert.equal(found.at(-1), RECITAL.title);
  });

  test("an embedding from another model is never compared with the query", async () => {
    // The gallery's embedding is exactly the query's, yet it is not first, and by meaning alone it scores nothing.
    const found = await titles({ query: MEANING_ONLY });
    assert.notEqual(found[0], GALLERY.title);
    assert.equal(found.at(-1), GALLERY.title);
  });

  test("the query text never adds or removes a result", async () => {
    for (const query of [MEANING_ONLY, WORDS_AND_MEANING, "zzyzx"]) {
      const result = await search({ query });
      assert.deepEqual(result.items.map((item) => item.title).sort(), [...BY_DATE].sort(), query);
      assert.equal(result.total, ALL.length, query);
    }
  });

  test("paging applies after the ordering, and the total counts every match", async () => {
    const whole = await titles({ query: WORDS_AND_MEANING });
    const first = await search({ query: WORDS_AND_MEANING, limit: 2, offset: 0 });
    const second = await search({ query: WORDS_AND_MEANING, limit: 2, offset: 2 });
    const last = await search({ query: WORDS_AND_MEANING, limit: 2, offset: 4 });

    assert.deepEqual(
      [...first.items, ...second.items, ...last.items].map((item) => item.title),
      whole,
    );
    assert.deepEqual(
      [first.total, second.total, last.total],
      [ALL.length, ALL.length, ALL.length],
    );
  });

  test("when the model fails, the order is by keyword alone and the search succeeds", async () => {
    model.fail();
    try {
      const found = await titles({ query: WORDS_AND_MEANING });
      // Both romantic evenings first, the cruise ahead by its words; the gallery third; then the rest by date.
      assert.deepEqual(found, [CRUISE.title, CONCERT.title, GALLERY.title, SALE.title, RECITAL.title, WALK.title]);
    } finally {
      model.failOn = () => false;
    }
  });

});
