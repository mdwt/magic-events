import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { events, experience, rawListing, undefinedValue, warehouseExperience } from "@magic-events/db";
import { asc, eq } from "drizzle-orm";
import type { Source, SourceFetcher } from "../src/discovery/ports.ts";
import { LanguageModelFailed, type LanguageModelRequest } from "../src/shared/language-model.ts";
import { answered, extraction, session } from "./fixtures/processing/answers.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// The pipeline against the database: a fake page is fetched by Discovery, processed by Data processing with a
// scripted language model, saved by Catalogue, and found by search.

const PAGE_URL = "https://fynarts.example.com/";
let page = "<html><body><h1>Hermanus FynArts</h1><p>12 to 21 June 2027</p></body></html>";
let failExtraction = false;

const fetcher: SourceFetcher = {
  kind: "web_page",
  fetch: () =>
    Promise.resolve({
      listings: [{ sourceListingId: PAGE_URL, url: PAGE_URL, contentType: "text/html", content: page }],
      complete: true,
      syncState: {},
    }),
};

// The model reads the dates off the page, so a changed page gives a changed experience.
const model = fakeLanguageModel({
  extract: (request: LanguageModelRequest<unknown>) => {
    if (failExtraction) return new LanguageModelFailed("wrong_shape");
    const moved = request.text.includes("19 to 28 June 2027");
    return extraction(
      answered({
        booking: moved ? "open" : "not_yet",
        status: moved ? "confirmed" : "announced",
        sessions: [moved ? session({ start: "2027-06-19", end: "2027-06-28" }) : session()],
        bookingUrl: moved ? "https://fynarts.example.com/tickets" : "",
      }),
    );
  },
  classify: () => ({
    attributes: [
      { key: "category", values: ["visual_arts", "music"] },
      { key: "vibe", values: ["arty"] },
    ],
    tags: ["jazz"],
    profile: "A ten-day arts festival across Hermanus, with exhibitions, concerts and talks.",
  }),
});

let harness: Harness;
let source: Source;
// Time moves on a minute with every look at the clock, so each run and each version has its own time.
let minutes = 0;
const clock = () => new Date(Date.parse("2026-11-23T08:00:00Z") + minutes++ * 60_000);

before(async () => {
  harness = await createHarness({ languageModel: model, fetchers: [fetcher], clock });
  const { catalogue, dataProcessing, discovery } = harness.services;
  await catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "South Africa",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
  await dataProcessing.saveAttribute({
    key: "category",
    name: "Category",
    description: "What it is about",
    type: "option",
    defaultValue: null,
    multiple: true,
    filterable: true,
    options: [
      { key: "music", name: "Music", description: "Concerts" },
      { key: "visual_arts", name: "Visual arts", description: "Exhibitions" },
    ],
  });
  await dataProcessing.saveAttribute({
    key: "scale",
    name: "Scale",
    description: "How far people travel",
    type: "option",
    defaultValue: "local",
    multiple: false,
    filterable: true,
    options: [
      { key: "local", name: "Local", description: "The town" },
      { key: "major", name: "Major", description: "The country" },
    ],
  });
  await dataProcessing.saveTag({ slug: "jazz", name: "Jazz", description: "Jazz music" });
  await dataProcessing.saveSeason({
    locationSlug: "hermanus",
    slug: "whale-season",
    name: "Whale season",
    description: "Whales in the bay",
    periods: [{ startDate: "2027-06-01", endDate: "2027-11-30" }],
  });
  source = await discovery.saveSource({
    name: "FynArts site",
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [PAGE_URL] },
    maxProcessingAttempts: 3,
  });
});

after(async () => {
  await harness.close();
});

async function searchJune() {
  return harness.services.catalogue.searchExperiences({
    near: { lat: -34.4187, lng: 19.2345 },
    from: "2027-06-01",
    to: "2027-06-30",
    limit: 20,
    offset: 0,
  });
}

// How many of each domain event there are.
async function eventCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const row of await harness.db.select({ type: events.type }).from(events)) {
    counts[row.type] = (counts[row.type] ?? 0) + 1;
  }
  return counts;
}

describe("The pipeline from a fetched page to a searchable experience", () => {
  test("a new page is processed into a published experience that search finds", async () => {
    const run = await harness.services.discovery.runSource(source.id);
    assert.equal(run.status, "succeeded");
    assert.equal(run.listingsNewOrChanged, 1);

    const outcomes = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      outcomes.map(({ outcome, experiences, created, error }) => ({ outcome, experiences, created, error })),
      [{ outcome: "processed", experiences: 1, created: 1, error: null }],
    );

    const found = await searchJune();
    assert.equal(found.total, 1);
    const [item] = found.items;
    assert.ok(item);
    assert.equal(item.title, "Hermanus FynArts");
    assert.equal(item.status, "announced");
    assert.equal(item.booking, "not_yet");
    assert.deepEqual(item.attributes, { category: ["music", "visual_arts"], scale: ["local"] });
    assert.deepEqual([...item.tags].sort(), ["jazz", "whale-season"]);
    assert.deepEqual(
      item.sessions.map((one) => [one.startDate, one.endDate]),
      [["2027-06-12", "2027-06-21"]],
    );
    assert.equal(item.version, 1);

    const rows = await harness.db.select().from(warehouseExperience);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.experienceId, item.id);
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].experience.title, "Hermanus FynArts");

    const undefinedRows = await harness.db.select().from(undefinedValue);
    assert.deepEqual(
      undefinedRows.map(({ kind, value }) => ({ kind, value })),
      [{ kind: "attribute", value: "vibe" }],
    );

    assert.deepEqual(await eventCounts(), {
      "raw_listing.captured": 1,
      "experience.published": 1,
      "raw_listing.processed": 1,
    });
  });

  test("a second run with the same page processes nothing", async () => {
    const run = await harness.services.discovery.runSource(source.id);
    assert.equal(run.listingsUnchanged, 1);
    assert.deepEqual(await harness.services.dataProcessing.processPending(), []);
    assert.equal((await harness.db.select().from(warehouseExperience)).length, 1);
  });

  test("a changed page updates the same experience and bumps its version", async () => {
    page = "<html><body><h1>Hermanus FynArts</h1><p>19 to 28 June 2027. Tickets on sale.</p></body></html>";
    await harness.services.discovery.runSource(source.id);
    const outcomes = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      outcomes.map(({ outcome, created, changed }) => ({ outcome, created, changed })),
      [{ outcome: "processed", created: 0, changed: 1 }],
    );

    const found = await searchJune();
    assert.equal(found.total, 1);
    const [item] = found.items;
    assert.equal(item?.version, 2);
    assert.equal(item.status, "confirmed");
    assert.equal(item.booking, "open");
    assert.deepEqual(
      item.sessions.map((one) => [one.startDate, one.endDate]),
      [["2027-06-19", "2027-06-28"]],
    );

    const rows = await harness.db
      .select({ version: warehouseExperience.version })
      .from(warehouseExperience)
      .orderBy(asc(warehouseExperience.recordedAt));
    assert.deepEqual(
      rows.map((row) => row.version),
      [1, 2],
    );
    assert.deepEqual(await eventCounts(), {
      "raw_listing.captured": 2,
      "experience.published": 1,
      "experience.changed": 1,
      "raw_listing.processed": 2,
    });
  });

  test("a failing extraction leaves nothing behind, and the raw listing is retried up to its limit", async () => {
    failExtraction = true;
    page = "<html><body><h1>Hermanus FynArts</h1><p>Programme coming soon.</p></body></html>";
    await harness.services.discovery.runSource(source.id);
    const outcomes = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome),
      ["failed", "failed", "failed"],
    );
    assert.match(outcomes[0]?.error ?? "", /wrong_shape/);

    const [stored] = await harness.db.select({ version: experience.version }).from(experience);
    assert.equal(stored?.version, 2);
    assert.equal((await harness.db.select().from(warehouseExperience)).length, 2);
    const failed = await harness.db
      .select({ status: rawListing.status, attempts: rawListing.attempts })
      .from(rawListing)
      .where(eq(rawListing.status, "failed"));
    assert.deepEqual(failed, [{ status: "failed", attempts: 3 }]);
    const counts = await eventCounts();
    assert.equal(counts["raw_listing.failed"], 3);
    assert.equal(counts["experience.changed"], 1);
    assert.deepEqual(await harness.services.dataProcessing.processPending(), []);
  });
});
