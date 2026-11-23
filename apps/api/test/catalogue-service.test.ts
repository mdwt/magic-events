import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  CatalogueRepository,
  ExperienceRecord,
  ExperienceSearchQuery,
  Location,
  SearchExperiencesInput,
} from "../src/core/catalogue/ports.ts";
import { CatalogueService } from "../src/core/catalogue/service.ts";
import { AppError } from "../src/core/shared/errors.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import { EMBEDDING_SETTINGS, FakeEmbeddingModel } from "./helpers/fake-embedding-model.ts";

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
  };
  return { repository, queries };
}

function service(repository: CatalogueRepository, embeddings = new FakeEmbeddingModel()) {
  return new CatalogueService({
    repository,
    events: { publish: () => {} },
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

  test("bookable asks for Confirmed with booking Open", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, bookable: true });

    assert.deepEqual(queries[0]?.statuses, ["confirmed"]);
    assert.deepEqual(queries[0].bookings, ["open"]);
  });

  test("bookable with statuses that leave out Confirmed asks for nothing", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, bookable: true, status: ["expected", "announced"] });

    assert.deepEqual(queries[0]?.statuses, []);
    assert.deepEqual(queries[0].bookings, ["open"]);
  });

  test("bookable false puts no limit on booking", async () => {
    const { repository, queries } = fakeRepository();
    await service(repository).searchExperiences({ ...base, bookable: false });

    assert.deepEqual(queries[0]?.statuses, ["expected", "announced", "confirmed", "postponed"]);
    assert.equal(queries[0].bookings, undefined);
  });

  test("marks an experience bookable only when it is Confirmed with booking Open", async () => {
    const { repository } = fakeRepository([
      record({ id: "00000000-0000-4000-8000-000000000001", status: "confirmed", booking: "open" }),
      record({ id: "00000000-0000-4000-8000-000000000002", status: "confirmed", booking: "sold_out" }),
      record({ id: "00000000-0000-4000-8000-000000000003", status: "announced", booking: "open" }),
      record({ id: "00000000-0000-4000-8000-000000000004", status: "confirmed", booking: "none" }),
    ]);
    const result = await service(repository).searchExperiences(base);

    assert.deepEqual(
      result.items.map((item) => item.bookable),
      [true, false, false, false],
    );
    assert.equal(result.total, 4);
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
