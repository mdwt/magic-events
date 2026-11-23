import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  CatalogueRepository,
  ExperienceSearchQuery,
  ExperienceToEmbed,
  SearchExperiencesInput,
} from "../src/catalogue/ports.ts";
import { CatalogueService } from "../src/catalogue/service.ts";
import { AppError } from "../src/shared/errors.ts";
import type { Logger } from "../src/shared/logger.ts";
import type { EmbeddingSettings } from "../src/shared/settings.ts";
import { EMBEDDING_SETTINGS, FakeEmbeddingModel, point } from "../src/testing/fake-embedding-model.ts";

// Catalogue's embedding pieces with no database: the query text's embedding in a search, and a round of embedding.

const notUsed = () => Promise.reject(new Error("not used"));

function logger() {
  const lines: { level: string; message: string; context: object }[] = [];
  const log: Logger = {
    debug: (context, message) => lines.push({ level: "debug", message, context }),
    info: (context, message) => lines.push({ level: "info", message, context }),
    warn: (context, message) => lines.push({ level: "warn", message, context }),
    error: (context, message) => lines.push({ level: "error", message, context }),
    child: () => log,
  };
  return { log, lines };
}

// A repository that keeps the experiences due an embedding and what was stored, and records the search queries.
function fakeRepository(due: ExperienceToEmbed[] = []) {
  const queries: ExperienceSearchQuery[] = [];
  const stored: { model: string; id: string; title: string; vector: number[] }[] = [];
  const limits: number[] = [];
  // How many times the model failed on each experience's text.
  const failures = new Map<string, number>();
  const repository: CatalogueRepository = {
    searchExperiences(query) {
      queries.push(query);
      return Promise.resolve({ items: [], total: 0 });
    },
    findExperiencesToEmbed(query) {
      limits.push(query.limit);
      const left = due.filter(
        (one) =>
          !stored.some((done) => done.id === one.id && done.model === query.model) &&
          (failures.get(one.id) ?? 0) < query.maxAttempts,
      );
      return Promise.resolve({ items: left.slice(0, query.limit), total: left.length });
    },
    recordEmbeddingFailures(input) {
      for (const one of input.experiences) failures.set(one.id, (failures.get(one.id) ?? 0) + 1);
      return Promise.resolve(
        input.experiences.filter((one) => (failures.get(one.id) ?? 0) >= input.maxAttempts).map((one) => one.id),
      );
    },
    storeEmbeddings(input) {
      for (const one of input.embeddings) stored.push({ model: input.model, id: one.id, title: one.title, vector: one.vector });
      return Promise.resolve(input.embeddings.length);
    },
    upsertLocation: notUsed,
    findLocation: notUsed,
    loadExperiences: notUsed,
    findExperienceId: notUsed,
    findMatchCandidateIds: notUsed,
    findTakenSlugs: notUsed,
    saveExperiences: notUsed,
    findChangesSince: notUsed,
    findUpkeepCandidates: notUsed,
  };
  return { repository, queries, stored, limits, failures };
}

function service(
  repository: CatalogueRepository,
  embeddings: FakeEmbeddingModel,
  options: { settings?: Partial<EmbeddingSettings>; log?: Logger } = {},
) {
  return new CatalogueService({
    repository,
    events: { publish: () => {} },
    dataProcessing: { listAttributes: () => Promise.resolve([]) },
    settings: { searchDefaultRadiusKm: 25, searchMaxRadiusKm: 200, sessionHorizonMonths: 24, upkeepCron: "0 * * * *" },
    embeddings,
    embeddingSettings: { ...EMBEDDING_SETTINGS, ...options.settings },
    logger: options.log ?? logger().log,
  });
}

const search: SearchExperiencesInput = {
  near: { lat: -34.4187, lng: 19.2345 },
  from: "2027-06-10",
  to: "2027-06-20",
  limit: 20,
  offset: 0,
};

describe("a search's query text", () => {
  test("without a query text, the embedding model is not asked", async () => {
    const { repository, queries } = fakeRepository();
    const model = new FakeEmbeddingModel();
    await service(repository, model).searchExperiences(search);
    assert.equal(model.calls.length, 0);
    assert.equal(queries[0]?.queryEmbedding, undefined);
  });

  test("is embedded once, as a query, and its embedding and model are handed to the repository", async () => {
    const { repository, queries } = fakeRepository();
    const model = new FakeEmbeddingModel({ model: "titan-test", table: { "quiet and romantic": [1, 2] } });
    await service(repository, model).searchExperiences({ ...search, query: "quiet and romantic" });

    assert.deepEqual(model.calls, [{ texts: ["quiet and romantic"], purpose: "query" }]);
    const [query] = queries;
    assert.ok(query);
    assert.deepEqual(query.queryEmbedding, { vector: point([1, 2]), model: "titan-test" });
    assert.equal(query.query, "quiet and romantic");
  });

  test("a model that fails leaves the search to the keyword order, and the search succeeds", async () => {
    const { repository, queries } = fakeRepository();
    const model = new FakeEmbeddingModel();
    model.fail();
    const { log, lines } = logger();
    const result = await service(repository, model, { log }).searchExperiences({ ...search, query: "art" });

    assert.deepEqual(result, { items: [], total: 0, limit: 20, offset: 0 });
    const [query] = queries;
    assert.ok(query);
    assert.equal(query.query, "art");
    assert.equal(query.queryEmbedding, undefined);
    assert.ok(lines.some((line) => line.level === "error" && /keyword alone/.test(line.message)));
  });

  test("a model that does not answer in time leaves the search to the keyword order", async () => {
    const { repository, queries } = fakeRepository();
    const model = new FakeEmbeddingModel();
    model.hang = true;
    const started = performance.now();
    await service(repository, model, { settings: { queryTimeoutSeconds: 0.05 } }).searchExperiences({
      ...search,
      query: "art",
    });

    assert.ok(performance.now() - started < 1000);
    assert.equal(queries.length, 1);
    assert.equal(queries[0]?.queryEmbedding, undefined);
  });
});

describe("CatalogueService.embedExperiences", () => {
  const whale: ExperienceToEmbed = {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Whale Festival",
    profile: "A family festival on the cliffs, for the southern right whales.",
  };
  const market: ExperienceToEmbed = { id: "00000000-0000-4000-8000-000000000002", title: "Country Market", profile: null };
  const blank: ExperienceToEmbed = { id: "00000000-0000-4000-8000-000000000003", title: "Art Walk", profile: "  " };

  test("embeds the title on the first line and then the profile, as documents, and stores the model's name", async () => {
    const { repository, stored } = fakeRepository([whale, market, blank]);
    const model = new FakeEmbeddingModel({ model: "titan-test" });
    const result = await service(repository, model).embedExperiences();

    assert.deepEqual(result, { embedded: 3, failed: 0, setAside: 0, remaining: 0 });
    assert.deepEqual(model.calls, [
      {
        texts: [
          "Whale Festival\nA family festival on the cliffs, for the southern right whales.",
          "Country Market",
          "Art Walk",
        ],
        purpose: "document",
      },
    ]);
    assert.deepEqual(
      stored.map(({ model: name, id }) => ({ name, id })),
      [whale, market, blank].map(({ id }) => ({ name: "titan-test", id })),
    );
    assert.ok(stored.every((one) => one.vector.length === 1024));
  });

  test("takes at most the batch size in one round, and says how many remain", async () => {
    const { repository, limits } = fakeRepository([whale, market, blank]);
    const embeddings = new FakeEmbeddingModel();
    const catalogue = service(repository, embeddings, { settings: { batchSize: 2 } });

    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 2, failed: 0, setAside: 0, remaining: 1 });
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 1, failed: 0, setAside: 0, remaining: 0 });
    assert.deepEqual(limits, [2, 2]);
  });

  test("a text the model fails on is left for the next round, and the others are stored", async () => {
    const { repository, stored } = fakeRepository([whale, market, blank]);
    const model = new FakeEmbeddingModel();
    model.failOn = (text) => text === "Country Market";
    const catalogue = service(repository, model);

    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 2, failed: 1, setAside: 0, remaining: 1 });
    assert.deepEqual(
      stored.map((one) => one.id),
      [whale.id, blank.id],
    );

    // The next round takes it again; the model answers this time.
    model.failOn = () => false;
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 1, failed: 0, setAside: 0, remaining: 0 });
    assert.deepEqual(model.documents().filter((text) => text === "Country Market").length, 3);
  });

  test("a model that fails on every text and on a test text is unavailable: nothing is counted and the round fails", async () => {
    const { repository, stored, failures } = fakeRepository([whale, market]);
    const model = new FakeEmbeddingModel();
    model.fail();
    await assert.rejects(service(repository, model).embedExperiences(), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /failed on all 2 experiences/);
      return true;
    });
    assert.deepEqual(model.calls.at(-1), { texts: ["Hermanus"], purpose: "document" });
    assert.equal(stored.length, 0);
    assert.equal(failures.size, 0);
  });

  test("a text the model keeps failing on is set aside after the most attempts, logged once, and no longer due", async () => {
    const { repository, stored, failures } = fakeRepository([whale, market]);
    const model = new FakeEmbeddingModel();
    model.failOn = (text) => text === "Country Market";
    const { log, lines } = logger();
    const catalogue = service(repository, model, { settings: { maxAttempts: 3 }, log });

    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 1, failed: 1, setAside: 0, remaining: 1 });
    // Alone in a round, it fails while the model answers a test text, so it is counted and the round succeeds.
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 0, failed: 1, setAside: 0, remaining: 1 });
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 0, failed: 1, setAside: 1, remaining: 0 });
    assert.equal(failures.get(market.id), 3);
    assert.deepEqual(
      stored.map((one) => one.id),
      [whale.id],
    );

    const setAside = lines.filter((line) => /set aside/.test(line.message));
    assert.deepEqual(
      setAside.map((line) => [line.level, line.context]),
      [["warn", { experienceId: market.id, attempts: 3 }]],
    );
    // Nothing is due any more, so the model is not asked again.
    const calls = model.calls.length;
    assert.deepEqual(await catalogue.embedExperiences(), { embedded: 0, failed: 0, setAside: 0, remaining: 0 });
    assert.equal(model.calls.length, calls);
  });

  test("nothing is embedded when nothing is due", async () => {
    const { repository } = fakeRepository([]);
    const model = new FakeEmbeddingModel();
    assert.deepEqual(await service(repository, model).embedExperiences(), { embedded: 0, failed: 0, setAside: 0, remaining: 0 });
    assert.equal(model.calls.length, 0);
  });
});
