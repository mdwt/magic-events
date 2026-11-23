import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { events, experience, listing, rawListing, run } from "@magic-events/db";
import { asc, eq } from "drizzle-orm";
import type { Source, SourceFetcher } from "../src/discovery/ports.ts";
import { LanguageModelFailed, type LanguageModelRequest } from "../src/shared/language-model.ts";
import { answered, extraction, session } from "./fixtures/processing/answers.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Fetching again and processing again, against the database: pages are fetched by Discovery and processed with a
// scripted language model, then sent back for processing by listing, experience, source and location.

const FYNARTS_URL = "https://fynarts.example.com/";
const WHALES_URL = "https://whales.example.com/";
const MARKET_URL = "https://stanford.example.com/market";

// What each address serves. An address left out is gone from its source.
const pages = new Map<string, string>([
  [FYNARTS_URL, "<html><body><h1>Hermanus FynArts</h1><p>12 to 21 June 2027</p></body></html>"],
  [WHALES_URL, "<html><body><h1>Whale Festival</h1><p>24 to 26 September 2027</p></body></html>"],
  [MARKET_URL, "<html><body><h1>Stanford Market</h1><p>6 March 2027</p></body></html>"],
]);

// Each source fetches the addresses in its settings.
const fetcher: SourceFetcher = {
  kind: "web_page",
  fetch: (input) => {
    const urls = Array.isArray(input.settings.urls) ? input.settings.urls : [];
    const listings = urls.flatMap((url) => {
      const content = typeof url === "string" ? pages.get(url) : undefined;
      return typeof url === "string" && content !== undefined
        ? [{ sourceListingId: url, url, contentType: "text/html", content }]
        : [];
    });
    return Promise.resolve({ listings, complete: true, syncState: {} });
  },
};

const DATES: Record<string, { start: string; end: string }> = {
  "Hermanus FynArts": { start: "2027-06-12", end: "2027-06-21" },
  "Whale Festival": { start: "2027-09-24", end: "2027-09-26" },
  "Stanford Market": { start: "2027-03-06", end: "2027-03-06" },
};
let failExtraction = false;
// Makes the model read the FynArts page as on sale, whatever it says.
let fynartsOnSale = false;

// The model reads the title off the page, and the booking from whether tickets are on sale. Any other change to
// a page leaves its answer as it was.
const model = fakeLanguageModel({
  extract: (request: LanguageModelRequest<unknown>) => {
    if (failExtraction) return new LanguageModelFailed("wrong_shape");
    const title = Object.keys(DATES).find((one) => request.text.includes(one));
    if (title === undefined) return extraction();
    const onSale = request.text.includes("Tickets on sale") || (fynartsOnSale && title === "Hermanus FynArts");
    return extraction(
      answered({
        title,
        status: onSale ? "confirmed" : "announced",
        booking: onSale ? "open" : "not_yet",
        sessions: [session(DATES[title])],
      }),
    );
  },
  classify: () => ({ attributes: [], tags: [], profile: "A festival or a market in the Overberg." }),
});

let harness: Harness;
let fynarts: Source;
let whales: Source;
let market: Source;
let inactive: Source;
// Time moves on a minute with every look at the clock, so each run and each version has its own time.
let minutes = 0;
const clock = () => new Date(Date.parse("2026-11-23T08:00:00Z") + minutes++ * 60_000);

before(async () => {
  harness = await createHarness({ languageModel: model, fetchers: [fetcher], clock });
  const { catalogue, discovery } = harness.services;
  const place = { country: "South Africa", region: "Western Cape", timezone: "Africa/Johannesburg" };
  await catalogue.saveLocation({ ...place, name: "Hermanus", slug: "hermanus", latitude: -34.419, longitude: 19.234 });
  await catalogue.saveLocation({ ...place, name: "Stanford", slug: "stanford", latitude: -34.4414, longitude: 19.459 });
  fynarts = await discovery.saveSource({
    name: "FynArts site",
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [FYNARTS_URL] },
    maxProcessingAttempts: 3,
  });
  whales = await discovery.saveSource({
    name: "Whale pages",
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [WHALES_URL] },
    missedRunsBeforeRemoval: 1,
  });
  inactive = await discovery.saveSource({
    name: "Old pages",
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [FYNARTS_URL] },
    active: false,
  });
  market = await discovery.saveSource({
    name: "Stanford pages",
    kind: "web_page",
    locationSlug: "stanford",
    settings: { urls: [MARKET_URL] },
  });
});

after(async () => {
  await harness.close();
});

// The one listing of a source.
async function listingOf(of: Source): Promise<string> {
  const [row] = await harness.db.select({ id: listing.id }).from(listing).where(eq(listing.sourceId, of.id));
  assert.ok(row);
  return row.id;
}

// A source's raw listings, oldest first.
async function versionsOf(of: Source) {
  return harness.db
    .select({ id: rawListing.id, status: rawListing.status, attempts: rawListing.attempts, error: rawListing.error })
    .from(rawListing)
    .innerJoin(listing, eq(listing.id, rawListing.listingId))
    .where(eq(listing.sourceId, of.id))
    .orderBy(asc(rawListing.fetchedAt), asc(rawListing.id));
}

async function statusesOf(of: Source) {
  return (await versionsOf(of)).map((version) => version.status);
}

async function experienceTitled(title: string) {
  const rows = await harness.db
    .select({ id: experience.id, slug: experience.slug, version: experience.version, status: experience.status })
    .from(experience)
    .where(eq(experience.title, title));
  assert.equal(rows.length, 1, `one experience titled ${title}`);
  const [row] = rows;
  assert.ok(row);
  return row;
}

async function eventCount(): Promise<number> {
  return (await harness.db.select({ id: events.id }).from(events)).length;
}

describe("Fetching again and processing again", () => {
  test("runLocation fetches every active source of the location, and not another location's", async () => {
    const runs = await harness.services.discovery.runLocation("hermanus");

    assert.deepEqual(
      runs.map((one) => [one.sourceName, one.status, one.listingsNewOrChanged]),
      [
        ["FynArts site", "succeeded", 1],
        ["Whale pages", "succeeded", 1],
      ],
    );
    const fetched = await harness.db.select({ sourceId: run.sourceId }).from(run);
    assert.deepEqual(fetched.map((one) => one.sourceId).sort(), [fynarts.id, whales.id].sort());
    assert.ok(!fetched.some((one) => one.sourceId === inactive.id || one.sourceId === market.id));

    await harness.services.discovery.runSource(market.id);
    const outcomes = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      outcomes.map((one) => [one.outcome, one.created]),
      [
        ["processed", 1],
        ["processed", 1],
        ["processed", 1],
      ],
    );
    assert.equal((await harness.db.select().from(experience)).length, 3);
  });

  test("a listing sent back is processed into the same experience, and no new version if nothing changed", async () => {
    const before = await experienceTitled("Hermanus FynArts");
    const appended = await eventCount();
    const fynartsListing = await listingOf(fynarts);

    const result = await harness.services.dataProcessing.reprocess({ listingId: fynartsListing });

    assert.deepEqual(result, { requeued: 1, listingIds: [fynartsListing] });
    assert.deepEqual(
      (await versionsOf(fynarts)).map(({ status, attempts, error }) => [status, attempts, error]),
      [["pending", 0, null]],
    );
    assert.deepEqual(await statusesOf(whales), ["processed"]);
    assert.deepEqual(await statusesOf(market), ["processed"]);
    // Sending back appends no domain event.
    assert.equal(await eventCount(), appended);
    // Already pending, so a second time sends nothing back.
    assert.deepEqual(await harness.services.dataProcessing.reprocess({ listingId: fynartsListing }), {
      requeued: 0,
      listingIds: [],
    });

    const outcomes = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      outcomes.map((one) => [one.outcome, one.experiences, one.created, one.changed]),
      [["processed", 1, 0, 0]],
    );
    assert.deepEqual(await experienceTitled("Hermanus FynArts"), before);
    assert.equal((await harness.db.select().from(experience)).length, 3);
  });

  test("an experience sent back by its slug is updated once the same page reads differently", async () => {
    const before = await experienceTitled("Hermanus FynArts");
    // As a fixed extractor would: the page stored before now reads as on sale.
    fynartsOnSale = true;

    const result = await harness.services.dataProcessing.reprocess({ experienceId: before.slug });

    assert.deepEqual(result, { requeued: 1, listingIds: [await listingOf(fynarts)] });
    const outcomes = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      outcomes.map((one) => [one.outcome, one.created, one.changed]),
      [["processed", 0, 1]],
    );
    const afterwards = await experienceTitled("Hermanus FynArts");
    assert.deepEqual(afterwards, { ...before, version: before.version + 1, status: "confirmed" });
    assert.deepEqual(await statusesOf(fynarts), ["processed"]);
    assert.equal((await harness.db.select().from(experience)).length, 3);
  });

  test("sending back an experience by its ID sends back every listing it is linked to", async () => {
    const whaleFestival = await experienceTitled("Whale Festival");
    const result = await harness.services.dataProcessing.reprocess({ experienceId: whaleFestival.id });
    assert.deepEqual(result, { requeued: 1, listingIds: [await listingOf(whales)] });
    const [version] = await versionsOf(whales);
    assert.deepEqual({ status: version?.status, attempts: version?.attempts }, { status: "pending", attempts: 0 });
    assert.deepEqual(await statusesOf(fynarts), ["processed"]);
    await harness.services.dataProcessing.processPending();
  });

  test("sending back a source by its name sends back its listings and no other source's", async () => {
    const result = await harness.services.dataProcessing.reprocess({ sourceName: "Whale pages" });
    assert.deepEqual(result, { requeued: 1, listingIds: [await listingOf(whales)] });
    assert.deepEqual(await statusesOf(whales), ["pending"]);
    assert.deepEqual(await statusesOf(fynarts), ["processed"]);
    assert.deepEqual(await statusesOf(market), ["processed"]);
    await harness.services.dataProcessing.processPending();
  });

  test("sending back a location by its slug sends back its listings and no other location's", async () => {
    const result = await harness.services.dataProcessing.reprocess({ locationSlug: "stanford" });
    assert.deepEqual(result, { requeued: 1, listingIds: [await listingOf(market)] });
    assert.deepEqual(await statusesOf(market), ["pending"]);
    assert.deepEqual(await statusesOf(whales), ["processed"]);

    const hermanus = await harness.services.dataProcessing.reprocess({ locationSlug: "hermanus" });
    assert.deepEqual([...hermanus.listingIds].sort(), [await listingOf(fynarts), await listingOf(whales)].sort());
    const outcomes = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      outcomes.map((one) => [one.outcome, one.created, one.changed]),
      [
        ["processed", 0, 0],
        ["processed", 0, 0],
        ["processed", 0, 0],
      ],
    );
    assert.equal((await harness.db.select().from(experience)).length, 3);
  });

  test("a failed latest version is sent back with no attempts and no error, and older ones never are", async () => {
    // A version that fails every attempt.
    failExtraction = true;
    pages.set(FYNARTS_URL, "<html><body><h1>Hermanus FynArts</h1><p>Programme soon.</p></body></html>");
    await harness.services.discovery.runSource(fynarts.id);
    await harness.services.dataProcessing.processPending();
    const failed = await versionsOf(fynarts);
    assert.deepEqual(
      failed.map(({ status, attempts }) => [status, attempts]),
      [
        ["processed", 0],
        ["failed", 3],
      ],
    );
    assert.match(failed[1]?.error ?? "", /wrong_shape/);

    failExtraction = false;
    await harness.services.dataProcessing.reprocess({ sourceName: "FynArts site" });
    const requeued = await versionsOf(fynarts);
    assert.deepEqual(
      requeued.map(({ status, attempts, error }) => [status, attempts, error]),
      [
        ["processed", 0, null],
        ["pending", 0, null],
      ],
    );
    await harness.services.dataProcessing.processPending();

    // A newer version arrives, and the one before it is superseded when the newer one is claimed.
    failExtraction = true;
    pages.set(FYNARTS_URL, "<html><body><h1>Hermanus FynArts</h1><p>Programme out.</p></body></html>");
    await harness.services.discovery.runSource(fynarts.id);
    await harness.services.dataProcessing.processPending();
    failExtraction = false;
    pages.set(FYNARTS_URL, "<html><body><h1>Hermanus FynArts</h1><p>Full programme.</p></body></html>");
    await harness.services.discovery.runSource(fynarts.id);
    await harness.services.dataProcessing.processPending();
    assert.deepEqual(await statusesOf(fynarts), ["processed", "processed", "superseded", "processed"]);

    // An older version left failed, as one is between a failure and the claim of a newer version.
    const older = (await versionsOf(fynarts))[1];
    assert.ok(older);
    await harness.db
      .update(rawListing)
      .set({ status: "failed", attempts: 3, error: "wrong_shape" })
      .where(eq(rawListing.id, older.id));

    await harness.services.dataProcessing.reprocess({ listingId: await listingOf(fynarts) });
    assert.deepEqual(await statusesOf(fynarts), ["processed", "failed", "superseded", "pending"]);
    await harness.services.dataProcessing.processPending();
    assert.equal((await harness.db.select().from(experience)).length, 3);
  });

  test("a listing that is gone from its source is not sent back", async () => {
    pages.delete(WHALES_URL);
    const gone = await harness.services.discovery.runSource(whales.id);
    assert.equal(gone.listingsRemoved, 1);
    await harness.services.dataProcessing.processPending();
    assert.equal((await experienceTitled("Whale Festival")).status, "removed");

    assert.deepEqual(await harness.services.dataProcessing.reprocess({ sourceName: "Whale pages" }), {
      requeued: 0,
      listingIds: [],
    });
    assert.deepEqual(await harness.services.dataProcessing.reprocess({ listingId: await listingOf(whales) }), {
      requeued: 0,
      listingIds: [],
    });
    const whaleFestival = await experienceTitled("Whale Festival");
    await assert.rejects(
      harness.services.dataProcessing.reprocess({ experienceId: whaleFestival.id }),
      /nothing to process again/,
    );
  });

  test("unknown listings, experiences, sources and locations are not found", async () => {
    const { dataProcessing, discovery } = harness.services;
    await assert.rejects(dataProcessing.reprocess({ listingId: "00000000-0000-4000-8000-000000000999" }), /No listing/);
    await assert.rejects(dataProcessing.reprocess({ listingId: "not-an-id" }), /No listing/);
    await assert.rejects(dataProcessing.reprocess({ experienceId: "no-such-experience" }), /No experience/);
    await assert.rejects(dataProcessing.reprocess({ sourceName: "Nobody's pages" }), /No source/);
    await assert.rejects(dataProcessing.reprocess({ locationSlug: "atlantis" }), /No location/);
    await assert.rejects(discovery.runLocation("atlantis"), /No location/);
    assert.equal(await discovery.getListing("not-an-id"), null);
    const found = await discovery.getListing(await listingOf(market));
    assert.deepEqual(found, {
      id: await listingOf(market),
      sourceId: market.id,
      sourceName: "Stanford pages",
      url: MARKET_URL,
      state: "listed",
    });
  });
});
