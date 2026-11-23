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
    listLocationSlugs: () => Promise.resolve([...locations.keys()].sort()),
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

// The slugs of the tags and seasons, as Data processing lists them.
const TAG_SLUGS = ["festival", "jazz", "whale-season", "whales", "winter"];

function service(
  repository: CatalogueRepository,
  embeddings = new FakeEmbeddingModel(),
  tagSlugs = TAG_SLUGS,
  definitions = DEFINITIONS,
) {
  return new CatalogueService({
    repository,
    events: { publish: () => {} },
    dataProcessing: { listAttributes: () => Promise.resolve(definitions), listTagSlugs: () => Promise.resolve(tagSlugs) },
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
    const none = await refusal(service(repository).searchExperiences({ ...placeless, location: "atlantis" }));
    assert.deepEqual(none.details, [
      {
        path: "location",
        message:
          "The feed does not cover a place called atlantis. It covers no place yet, so give a point with near.",
      },
    ]);

    // With places saved, the refusal names them.
    const catalogue = service(repository);
    for (const slug of ["stanford", "hermanus"]) {
      await catalogue.saveLocation({
        name: slug,
        slug,
        country: "ZA",
        region: "Western Cape",
        timezone: "Africa/Johannesburg",
        latitude: -34.4,
        longitude: 19.2,
      });
    }
    const unknown = await refusal(catalogue.searchExperiences({ ...placeless, location: "atlantis" }));
    assert.deepEqual(unknown.details, [
      {
        path: "location",
        message:
          "The feed does not cover a place called atlantis. It covers: hermanus, stanford. Give one of them, or a point with near.",
      },
    ]);

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
      { path: "attributes.colour", message: `There is no attribute called colour. You can filter on: ${filterable}.` },
      {
        path: "attributes.internal_note",
        message: `internal_note cannot be used as a filter. You can filter on: ${filterable}.`,
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
        message: "category has no option sport. Use one of: visual_arts, nature_and_wildlife, music.",
      },
      { path: "attributes.minimum_age", message: 'minimum_age takes a number, such as 12, or a range, such as { "max": 12 }.' },
      { path: "attributes.wheelchair_accessible", message: "wheelchair_accessible takes true or false." },
      { path: "attributes.dress_code", message: "dress_code takes no range. Give a value, or a list of values." },
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

describe("CatalogueService order by tier", () => {
  const tier: AttributeDefinition = {
    ...attribute("tier", "option", ["luxury", "premium", "standard", "everyday"]),
    defaultValue: "standard",
  };

  test("a search hands the repository the tier's options in order, and its default for no value", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository, new FakeEmbeddingModel(), TAG_SLUGS, [...DEFINITIONS, tier]).searchExperiences(base);
    assert.deepEqual(queries[0]?.rankBy, {
      attribute: "tier",
      options: ["luxury", "premium", "standard", "everyday"],
      fallback: "standard",
    });
  });

  test("a tier with no default puts an experience with no value last", async () => {
    const { repository, queries } = fakeRepository();
    const noDefault = { ...tier, defaultValue: null };
    await service(repository, new FakeEmbeddingModel(), TAG_SLUGS, [noDefault]).searchExperiences(base);
    assert.equal(queries[0]?.rankBy?.fallback, null);
  });

  test("with no tier attribute defined, the search is not ranked by one", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences(base);
    assert.equal(queries[0]?.rankBy, undefined);
  });
});

describe("CatalogueService tag filters", () => {
  test("a tag or season slug Data processing knows is passed through", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, tags: ["whales", "whale-season"] });
    assert.deepEqual(queries[0]?.tags, ["whales", "whale-season"]);
  });

  test("an unknown slug is refused, naming it and the closest ones", async () => {
    const { repository, queries } = fakeRepository();
    const error = await refusal(service(repository).searchExperiences({ ...base, tags: ["jazz", "whale"] }));
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(error.details, [
      {
        path: "tags.1",
        message: "There is no tag whale. The closest tags are: whales, whale-season, jazz, winter, festival.",
      },
    ]);
    assert.equal(queries.length, 0);
  });

  test("with hundreds of tags, the message names only the closest few", async () => {
    const many = Array.from({ length: 300 }, (_, index) => `tag-${String(index).padStart(3, "0")}`);
    const { repository } = fakeRepository();
    const searching = service(repository, new FakeEmbeddingModel(), many).searchExperiences({ ...base, tags: ["tag-10"] });
    const error = await refusal(searching);
    assert.deepEqual(
      error.details?.map((detail) => detail.message),
      ["There is no tag tag-10. The closest tags are: tag-100, tag-101, tag-102, tag-103, tag-104."],
    );
  });

  test("with no tags defined, any slug is refused", async () => {
    const { repository } = fakeRepository();
    const error = await refusal(service(repository, new FakeEmbeddingModel(), []).searchExperiences({ ...base, tags: ["jazz"] }));
    assert.deepEqual(error.details?.map((detail) => detail.message), [
      "There is no tag jazz, and there are no tags to filter on yet.",
    ]);
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
