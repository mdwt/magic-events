import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { experience } from "@magic-events/db";
import type { Source, SourceFetcher } from "../src/discovery/ports.ts";
import type { LanguageModelRequest } from "../src/shared/language-model.ts";
import { answered, extraction, session } from "./fixtures/processing/answers.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Sources that give the same experience different months, against the database: they are one experience, and
// it has the month of the source with the highest priority.

// Each source's page says which month the festival is in. The page's address is the month.
const fetcher: SourceFetcher = {
  kind: "web_page",
  fetch: ({ settings }) => {
    const url = (settings.urls as string[])[0] ?? "";
    return Promise.resolve({
      listings: [
        {
          sourceListingId: url,
          url,
          contentType: "text/html",
          content: `<html><body><h1>Hermanus Whale Festival</h1><p>Month: ${url.slice(-7)}</p></body></html>`,
        },
      ],
      complete: true,
      syncState: {},
    });
  },
};

// The model reads the month off the page.
const model = fakeLanguageModel({
  extract: (request: LanguageModelRequest<unknown>) => {
    const month = /Month: (\d{4}-\d{2})/.exec(request.text)?.[1] ?? "";
    return extraction(
      answered({
        title: "Hermanus Whale Festival",
        status: "announced",
        booking: "none",
        sessions: [session({ start: month, end: "", precision: "month" })],
      }),
    );
  },
  classify: () => ({ attributes: [], tags: [], profile: "A festival for the whales." }),
});

let harness: Harness;

async function source(name: string, priority: number, month: string): Promise<Source> {
  return harness.services.discovery.saveSource({
    name,
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [`https://${name.toLowerCase()}.example.com/${month}`] },
    priority,
  });
}

async function fetchAndProcess(one: Source) {
  await harness.services.discovery.runSource(one.id);
  return harness.services.dataProcessing.processPending();
}

async function stored() {
  const rows = await harness.db.select().from(experience);
  const found = await Promise.all(
    rows.map((row) => harness.services.catalogue.getExperience({ id: row.id })),
  );
  return found.filter((one) => one !== null);
}

before(async () => {
  harness = await createHarness({
    languageModel: model,
    fetchers: [fetcher],
    clock: () => new Date("2026-11-23T08:00:00Z"),
  });
  await harness.services.catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "South Africa",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
});

after(async () => {
  await harness.close();
});

describe("Sources that give the same experience different months", () => {
  test("a second source's month makes no second experience, and the higher priority's month leads", async () => {
    const first = await fetchAndProcess(await source("Aggregator", 5, "2027-09"));
    assert.deepEqual(
      first.map(({ outcome, created }) => ({ outcome, created })),
      [{ outcome: "processed", created: 1 }],
    );

    // A source with a higher priority says October: the same experience, now in October.
    const second = await fetchAndProcess(await source("Organiser", 30, "2027-10"));
    assert.deepEqual(
      second.map(({ outcome, created, changed }) => ({ outcome, created, changed })),
      [{ outcome: "processed", created: 0, changed: 1 }],
    );
    let [festival, ...others] = await stored();
    assert.equal(others.length, 0);
    assert.ok(festival);
    assert.equal(festival.listingIds.length, 2);
    assert.deepEqual(
      festival.sessions.map(({ startDate, endDate, precision }) => ({ startDate, endDate, precision })),
      [{ startDate: "2027-10-01", endDate: "2027-10-31", precision: "month" }],
    );

    // A source with a lower priority says November: it is linked, and only fills what is empty.
    const third = await fetchAndProcess(await source("Paper", 10, "2027-11"));
    assert.deepEqual(
      third.map(({ outcome, created }) => ({ outcome, created })),
      [{ outcome: "processed", created: 0 }],
    );
    [festival, ...others] = await stored();
    assert.equal(others.length, 0);
    assert.ok(festival);
    assert.equal(festival.listingIds.length, 3);
    assert.deepEqual(
      festival.sessions.map(({ startDate, endDate }) => [startDate, endDate]),
      [["2027-10-01", "2027-10-31"]],
    );
  });
});
