import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  CatalogueRepository,
  ExperienceRecord,
  ExperienceSearchQuery,
  Location,
  SearchExperiencesInput,
} from "../src/catalogue/ports.ts";
import { CatalogueService } from "../src/catalogue/service.ts";
import type { AttributeDefinition } from "../src/data-processing/ports.ts";
import { AppError } from "../src/shared/errors.ts";
import type { Logger } from "../src/shared/logger.ts";
import { EMBEDDING_SETTINGS, FakeEmbeddingModel } from "../src/testing/fake-embedding-model.ts";

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

function record(overrides: Partial<ExperienceRecord>): ExperienceRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Hermanus Country Market",
    slug: "hermanus-country-market",
    summary: null,
    description: null,
    type: "recurring",
    status: "confirmed",
    booking: "none",
    location: { slug: "hermanus", name: "Hermanus" },
    venue: { name: null, address: null, city: null, position: null },
    distanceKm: 1.2,
    timezone: "Africa/Johannesburg",
    openingHours: null,
    price: { min: null, max: null, currency: null },
    onSaleAt: null,
    bookingClosesAt: null,
    bookingUrl: null,
    imageUrl: null,
    pageUrl: null,
    attributes: {},
    tags: [],
    sessions: [],
    version: 1,
    updatedAt: "2026-11-23T10:00:00.000Z",
    ...overrides,
  };
}

// A repository that records the query it is handed and answers with the given records.
function fakeRepository(items: ExperienceRecord[] = []) {
  const queries: ExperienceSearchQuery[] = [];
  const locations = new Map<string, Location>();
  const repository: CatalogueRepository = {
    searchExperiences(query) {
      queries.push(query);
      return Promise.resolve({ items, total: items.length });
    },
    upsertLocation(input) {
      const saved = { id: locations.get(input.slug)?.id ?? crypto.randomUUID(), ...input };
      locations.set(input.slug, saved);
      return Promise.resolve(saved);
    },
    findLocation(by) {
      const found = [...locations.values()].find((one) => ("id" in by ? one.id === by.id : one.slug === by.slug));
      return Promise.resolve(found ?? null);
    },
    // Search never saves; the save side has its own tests.
    loadExperiences: () => Promise.resolve([]),
    findExperienceId: () => Promise.resolve(null),
    findMatchCandidateIds: () => Promise.resolve([]),
    findTakenSlugs: () => Promise.resolve([]),
    saveExperiences: () => Promise.resolve([]),
    findChangesSince: () => Promise.resolve({ items: [], total: 0 }),
    findUpkeepCandidates: () => Promise.resolve([]),
    findExperiencesToEmbed: () => Promise.resolve({ items: [], total: 0 }),
    storeEmbeddings: () => Promise.resolve(0),
    recordEmbeddingFailures: () => Promise.resolve([]),
  };
  return { repository, queries };
}

const option = (key: string) => ({ key, name: key, description: key });
const attribute = (key: string, type: AttributeDefinition["type"], options: string[] = []): AttributeDefinition => ({
  key,
  name: key,
  description: key,
  type,
  defaultValue: null,
  multiple: false,
  filterable: true,
  options: options.map(option),
});

// The definitions the service is handed by Data processing.
const DEFINITIONS: AttributeDefinition[] = [
  attribute("category", "option", ["visual_arts", "nature_and_wildlife", "music"]),
  attribute("minimum_age", "number"),
  attribute("wheelchair_accessible", "boolean"),
  attribute("dress_code", "text"),
  { ...attribute("internal_note", "text"), filterable: false },
];

function service(repository: CatalogueRepository, embeddings = new FakeEmbeddingModel()) {
  return new CatalogueService({
    repository,
    events: { publish: () => {} },
    dataProcessing: { listAttributes: () => Promise.resolve(DEFINITIONS) },
    settings: { searchDefaultRadiusKm: 25, searchMaxRadiusKm: 200, sessionHorizonMonths: 24, upkeepCron: "0 * * * *" },
    embeddings,
    embeddingSettings: EMBEDDING_SETTINGS,
    logger: silent,
  });
}

const base: SearchExperiencesInput = {
  near: { lat: -34.4187, lng: 19.2345 },
  from: "2027-06-10",
  to: "2027-06-20",
  limit: 20,
  offset: 0,
};

// The same search with no place given.
const placeless: SearchExperiencesInput = { from: base.from, to: base.to, limit: base.limit, offset: base.offset };

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "invalid_input");
    return error;
  }
  assert.fail("expected the search to be refused");
}

describe("CatalogueService.searchExperiences", () => {
  test("applies the defaults", async () => {
    const { repository, queries } = fakeRepository();
    const result = await service(repository).searchExperiences(base);

    assert.deepEqual(queries, [
      {
        near: base.near,
        radiusKm: 25,
        from: "2027-06-10",
        to: "2027-06-20",
        statuses: ["expected", "announced", "confirmed", "postponed"],
        attributes: {},
        tags: [],
        limit: 20,
        offset: 0,
      },
    ]);
    assert.deepEqual(result, { items: [], total: 0, limit: 20, offset: 0 });
  });

  test("passes the caller's filters through", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({
      ...base,
      radiusKm: 200,
      status: ["announced"],
      attributes: { category: ["visual_arts", "nature_and_wildlife"], minimum_age: { max: 12 } },
      tags: ["whales"],
      query: "quiet and romantic",
      limit: 5,
      offset: 10,
    });

    // The query text's embedding comes along with it; test/embedding-service.test.ts covers it.
    const { queryEmbedding, ...rest } = queries[0] ?? {};
    assert.equal(queryEmbedding?.model, "fake-embedding-model");
    assert.deepEqual(rest, {
      near: base.near,
      radiusKm: 200,
      from: "2027-06-10",
      to: "2027-06-20",
      statuses: ["announced"],
      attributes: { category: ["visual_arts", "nature_and_wildlife"], minimum_age: { max: 12 } },
      tags: ["whales"],
      query: "quiet and romantic",
      limit: 5,
      offset: 10,
    });
  });

  test("refuses a radius above the limit and names it", async () => {
    const { repository, queries } = fakeRepository();
    const error = await refusal(service(repository).searchExperiences({ ...base, radiusKm: 201 }));

    assert.match(error.message, /200 km/);
    assert.deepEqual(
      error.details?.map((detail) => detail.path),
      ["radiusKm"],
    );
    assert.equal(queries.length, 0);
  });

  test("refuses a last day before the first", async () => {
    const { repository } = fakeRepository();
    const error = await refusal(service(repository).searchExperiences({ ...base, from: "2027-06-20", to: "2027-06-10" }));

    assert.deepEqual(
      error.details?.map((detail) => detail.path),
      ["to"],
    );
  });

  test("accepts a one-day stay", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, from: "2027-06-10", to: "2027-06-10" });
    assert.equal(queries.length, 1);
  });

  test("refuses a range with neither min nor max, and one with min above max", async () => {
    const { repository } = fakeRepository();
    const empty = await refusal(service(repository).searchExperiences({ ...base, attributes: { minimum_age: {} } }));
    assert.deepEqual(
      empty.details?.map((detail) => detail.path),
      ["attributes.minimum_age"],
    );

    const inverted = await refusal(
      service(repository).searchExperiences({ ...base, attributes: { minimum_age: { min: 18, max: 12 } } }),
    );
    assert.deepEqual(
      inverted.details?.map((detail) => detail.path),
      ["attributes.minimum_age.min"],
    );
  });

  test("reports every problem at once", async () => {
    const { repository } = fakeRepository();
    const error = await refusal(
      service(repository).searchExperiences({ ...base, radiusKm: 500, from: "2027-06-20", to: "2027-06-10" }),
    );
    assert.deepEqual(
      error.details?.map((detail) => detail.path),
      ["radiusKm", "to"],
    );
  });

  test("a location's slug searches around its centre, with the default radius", async () => {
    const { repository, queries } = fakeRepository();
    const catalogue = service(repository);
    await catalogue.saveLocation({
      name: "Hermanus",
      slug: "hermanus",
      country: "ZA",
      region: "Western Cape",
      timezone: "Africa/Johannesburg",
      latitude: -34.4187,
      longitude: 19.2345,
    });
    await catalogue.searchExperiences({ ...placeless, location: "hermanus" });

    assert.deepEqual(queries[0]?.near, { lat: -34.4187, lng: 19.2345 });
    assert.equal(queries[0].radiusKm, 25);
  });

  test("refuses a location that does not exist, a search with no place, and one with both", async () => {
    const { repository, queries } = fakeRepository();
    const unknown = await refusal(service(repository).searchExperiences({ ...placeless, location: "atlantis" }));
    assert.deepEqual(unknown.details, [{ path: "location", message: "There is no location atlantis." }]);

    const neither = await refusal(service(repository).searchExperiences(placeless));
    assert.deepEqual(
      neither.details?.map((detail) => detail.path),
      ["location"],
    );

    const both = await refusal(service(repository).searchExperiences({ ...base, location: "hermanus" }));
    assert.deepEqual(
      both.details?.map((detail) => detail.path),
      ["near"],
    );
    assert.equal(queries.length, 0);
  });

  test("refuses an attribute that is not defined or cannot be filtered on, and names the ones that can", async () => {
    const { repository, queries } = fakeRepository();
    const error = await refusal(
      service(repository).searchExperiences({ ...base, attributes: { colour: "blue", internal_note: "vip" } }),
    );

    const filterable = "category, minimum_age, wheelchair_accessible, dress_code";
    assert.deepEqual(error.details, [
      { path: "attributes.colour", message: `There is no attribute colour. The attributes to filter on are: ${filterable}.` },
      {
        path: "attributes.internal_note",
        message: `internal_note cannot be filtered on. The attributes to filter on are: ${filterable}.`,
      },
    ]);
    assert.equal(queries.length, 0);
  });

  test("refuses a value that does not fit the attribute, and names an option attribute's options", async () => {
    const { repository, queries } = fakeRepository();
    const error = await refusal(
      service(repository).searchExperiences({
        ...base,
        attributes: {
          category: ["music", "sport"],
          minimum_age: "twelve",
          wheelchair_accessible: "yes",
          dress_code: { max: 3 },
        },
      }),
    );

    assert.deepEqual(error.details, [
      {
        path: "attributes.category",
        message: "category has no option sport. Its options are: visual_arts, nature_and_wildlife, music.",
      },
      { path: "attributes.minimum_age", message: "minimum_age is a number: give a number or a range, { min, max }." },
      { path: "attributes.wheelchair_accessible", message: "wheelchair_accessible is true or false." },
      { path: "attributes.dress_code", message: "dress_code is not a number, so it takes no range." },
    ]);
    assert.equal(queries.length, 0);
  });

  test("accepts filters that fit their attributes", async () => {
    const { repository, queries } = fakeRepository();
    const attributes = {
      category: "music",
      minimum_age: 12,
      wheelchair_accessible: true,
      dress_code: ["smart", "casual"],
    };
    await service(repository).searchExperiences({ ...base, attributes });
    assert.deepEqual(queries[0]?.attributes, attributes);
  });

  test("bookable asks for Confirmed and for bookable, which the repository reads as booking Open with a link", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, bookable: true });

    assert.deepEqual(queries[0]?.statuses, ["confirmed"]);
    assert.equal(queries[0].bookable, true);
  });

  test("bookable with statuses that leave out Confirmed asks for nothing", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, bookable: true, status: ["expected", "announced"] });

    assert.deepEqual(queries[0]?.statuses, []);
    assert.equal(queries[0].bookable, true);
  });

  test("bookable false puts no limit on booking", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, bookable: false });

    assert.deepEqual(queries[0]?.statuses, ["expected", "announced", "confirmed", "postponed"]);
    assert.equal(queries[0].bookable, undefined);
  });

  test("marks an experience bookable only when it is Confirmed with booking Open and a link to book through", async () => {
    const link = { bookingUrl: "https://tickets.example.com/market" };
    const { repository } = fakeRepository([
      record({ id: "00000000-0000-4000-8000-000000000001", status: "confirmed", booking: "open", ...link }),
      record({ id: "00000000-0000-4000-8000-000000000002", status: "confirmed", booking: "sold_out", ...link }),
      record({ id: "00000000-0000-4000-8000-000000000003", status: "announced", booking: "open", ...link }),
      record({ id: "00000000-0000-4000-8000-000000000004", status: "confirmed", booking: "none", ...link }),
      // No booking link: its own page will do, and with neither there is nothing to book through.
      record({
        id: "00000000-0000-4000-8000-000000000005",
        status: "confirmed",
        booking: "open",
        pageUrl: "https://whatson.example.com/market",
      }),
      record({ id: "00000000-0000-4000-8000-000000000006", status: "confirmed", booking: "open" }),
    ]);
    const result = await service(repository).searchExperiences(base);

    assert.deepEqual(
      result.items.map((item) => item.bookable),
      [true, false, false, false, true, false],
    );
    assert.equal(result.total, 6);
  });
});

describe("CatalogueService locations", () => {
  test("saves and gets a location through the repository", async () => {
    const { repository } = fakeRepository();
    const catalogue = service(repository);
    const saved = await catalogue.saveLocation({
      name: "Hermanus",
      slug: "hermanus",
      country: "ZA",
      region: "Western Cape",
      timezone: "Africa/Johannesburg",
      latitude: -34.4187,
      longitude: 19.2345,
    });

    assert.deepEqual(await catalogue.getLocation({ slug: "hermanus" }), saved);
    assert.deepEqual(await catalogue.getLocation({ id: saved.id }), saved);
    assert.equal(await catalogue.getLocation({ slug: "nowhere" }), null);
  });
});
