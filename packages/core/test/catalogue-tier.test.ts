import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createCatalogueRepository } from "../src/adapters/storage/catalogue-repository.ts";
import type { Catalogue, SearchExperiencesInput } from "../src/catalogue/ports.ts";
import { CatalogueService } from "../src/catalogue/service.ts";
import { attributes } from "../src/data-processing/default-attributes.ts";
import type { Logger } from "../src/shared/logger.ts";
import { insertExperienceFixture, type ExperienceFixture } from "../src/testing/experience-fixture.ts";
import { EMBEDDING_SETTINGS, FakeEmbeddingModel } from "../src/testing/fake-embedding-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Search orders its results most premium first, by the tier attribute's options in their order, against the
// database with the default definitions. A planner of a luxury trip sees the whale trip at the top and the free
// parkrun at the bottom, whatever their dates.

const HERMANUS = { lat: -34.4187, lng: 19.2345 };

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

let harness: Harness;
let catalogue: Catalogue;

const fixtures: (Omit<ExperienceFixture, "locationId"> & { date: string })[] = [
  { title: "Whale Coast Parkrun", date: "2027-06-10", tier: "everyday", profile: "A free 5 km run past the whales." },
  { title: "Craft Workshop", date: "2027-06-11", tier: "standard", profile: "Make a basket from fynbos." },
  { title: "Village Concert", date: "2027-06-12", profile: "Local singers in the hall." },
  { title: "Wine Pairing Dinner", date: "2027-06-13", tier: "premium", profile: "Five courses on a wine estate." },
  { title: "Whale Boat Trip", date: "2027-06-18", tier: "premium", profile: "A boat trip to see southern right whales." },
  { title: "Private Charter", date: "2027-06-19", tier: "luxury", profile: "Your own yacht and skipper for the day." },
].map(({ tier, ...one }) => ({ ...one, sessions: [], ...(tier === undefined ? {} : { attributes: { tier } }) }));

function search(input: Partial<SearchExperiencesInput> = {}, using: Catalogue = catalogue): Promise<string[]> {
  return using
    .searchExperiences({ near: HERMANUS, from: "2027-06-01", to: "2027-06-30", limit: 20, offset: 0, ...input })
    .then((result) => result.items.map((item) => item.title));
}

before(async () => {
  harness = await createHarness();
  catalogue = harness.services.catalogue;
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
  for (const { date, ...fixture } of fixtures) {
    await insertExperienceFixture(harness.db, { ...fixture, locationId: hermanus.id, sessions: [{ startDate: date }] });
  }
});

after(async () => {
  await harness.close();
});

describe("search ordered by tier", () => {
  test("without a query text, the most premium come first, then by date within a tier", async () => {
    assert.deepEqual(await search(), [
      "Private Charter",
      "Wine Pairing Dinner",
      "Whale Boat Trip",
      // No tier counts as the default, Standard, and is ordered by date among them.
      "Craft Workshop",
      "Village Concert",
      "Whale Coast Parkrun",
    ]);
  });

  test("with a query text, tier comes first and relevance orders within a tier", async () => {
    assert.deepEqual(await search({ query: "whales" }), [
      "Private Charter",
      // The boat trip matches the query and comes before the earlier wine dinner.
      "Whale Boat Trip",
      "Wine Pairing Dinner",
      "Craft Workshop",
      "Village Concert",
      // It matches the query too, and is still last: everyday.
      "Whale Coast Parkrun",
    ]);
  });

  test("the query text still never adds or removes a result", async () => {
    assert.deepEqual([...(await search({ query: "whales" }))].sort(), [...(await search())].sort());
  });

  test("tier is a filter like any other attribute", async () => {
    assert.deepEqual(await search({ attributes: { tier: ["premium", "luxury"] } }), [
      "Private Charter",
      "Wine Pairing Dinner",
      "Whale Boat Trip",
    ]);
    assert.deepEqual(await search({ attributes: { tier: "everyday" } }), ["Whale Coast Parkrun"]);
  });

  test("with no tier attribute defined, the order is by date as before", async () => {
    const untiered = new CatalogueService({
      repository: createCatalogueRepository(harness.db),
      events: { publish: () => {} },
      dataProcessing: { listAttributes: () => Promise.resolve([]), listTagSlugs: () => Promise.resolve([]) },
      settings: { searchDefaultRadiusKm: 25, searchMaxRadiusKm: 200, sessionHorizonMonths: 24, upkeepCron: "0 * * * *" },
      embeddings: new FakeEmbeddingModel(),
      embeddingSettings: EMBEDDING_SETTINGS,
      logger: silent,
    });
    assert.deepEqual(
      await search({}, untiered),
      fixtures.map((one) => one.title),
    );
  });
});
