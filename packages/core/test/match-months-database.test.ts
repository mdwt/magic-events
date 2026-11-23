import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { experience } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { Source, SourceFetcher } from "../src/discovery/ports.ts";
import type { LanguageModelRequest } from "../src/shared/language-model.ts";
import { answered, extraction, session } from "./fixtures/processing/answers.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Sources that give the same experience different months, against the database: they are one experience, and
// it has the month of the source with the highest priority.

// Each source's page names the festival and says which month it is in, as the page's address does:
// https://<source>.example.com/<festival>/<month>.
const fetcher: SourceFetcher = {
  kind: "web_page",
  fetch: ({ settings }) => {
    const url = (settings.urls as string[])[0] ?? "";
    const [festival = "", month = ""] = url.split("/").slice(-2);
    return Promise.resolve({
      listings: [
        {
          sourceListingId: url,
          url,
          contentType: "text/html",
          content: `<html><body><h1>Title: ${festival.replaceAll("-", " ")}</h1><p>Month: ${month}</p></body></html>`,
        },
      ],
      complete: true,
      syncState: {},
    });
  },
};

// The model reads the title and the month off the page.
const model = fakeLanguageModel({
  extract: (request: LanguageModelRequest<unknown>) => {
    const title = /Title: (.+?)\s+Month:/s.exec(request.text)?.[1] ?? "";
    const month = /Month: (\d{4}-\d{2})/.exec(request.text)?.[1] ?? "";
    return extraction(
      answered({
        title,
        status: "announced",
        booking: "none",
        sessions: [session({ start: month, end: "", precision: "month" })],
      }),
    );
  },
  classify: () => ({ attributes: [], tags: [], profile: "A festival for the whales." }),
});

let harness: Harness;
let minutes = 0;

async function source(name: string, priority: number, month: string, festival = "Hermanus Whale Festival"): Promise<Source> {
  const path = `${festival.replaceAll(" ", "-")}/${month}`;
  return harness.services.discovery.saveSource({
    name,
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [`https://${name.toLowerCase().replaceAll(" ", "-")}.example.com/${path}`] },
    priority,
  });
}

async function fetchAndProcess(one: Source) {
  await harness.services.discovery.runSource(one.id);
  return harness.services.dataProcessing.processPending();
}

async function stored(title = "Hermanus Whale Festival") {
  const rows = await harness.db.select().from(experience).where(eq(experience.title, title));
  const found = await Promise.all(
    rows.map((row) => harness.services.catalogue.getExperience({ id: row.id })),
  );
  return found.filter((one) => one !== null);
}

before(async () => {
  harness = await createHarness({
    languageModel: model,
    fetchers: [fetcher],
    // Time moves on a minute with every look at the clock, so each link has its own time.
    clock: () => new Date(Date.parse("2026-11-23T08:00:00Z") + minutes++ * 60_000),
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

  test("of two sources with the same priority, the one linked first keeps the lead, in whichever order they are processed", async () => {
    const first = await source("Xplorio tie", 5, "2027-09", "Hermanus Flower Festival");
    const second = await source("SA-Venues tie", 5, "2027-10", "Hermanus Flower Festival");
    await fetchAndProcess(first);
    // The second is not linked yet, so it only fills: the month stays September, and the new link is a version.
    await fetchAndProcess(second);
    const [linked] = await stored("Hermanus Flower Festival");
    assert.ok(linked);
    assert.equal(linked.version, 2);

    // Processed again in both orders, twice over: nothing changes any more.
    for (const order of [[second, first], [first, second], [second, first], [first, second]]) {
      for (const one of order) {
        await harness.services.dataProcessing.reprocess({ sourceName: one.name });
        const outcomes = await harness.services.dataProcessing.processPending();
        assert.deepEqual(
          outcomes.map(({ outcome, created, changed }) => ({ outcome, created, changed })),
          [{ outcome: "processed", created: 0, changed: 0 }],
        );
      }
    }
    const [festival, ...others] = await stored("Hermanus Flower Festival");
    assert.equal(others.length, 0);
    assert.ok(festival);
    assert.equal(festival.version, 2);
    assert.equal(festival.listingIds.length, 2);
    assert.deepEqual(
      festival.sessions.map(({ startDate, endDate }) => [startDate, endDate]),
      [["2027-09-01", "2027-09-30"]],
    );
  });
});
