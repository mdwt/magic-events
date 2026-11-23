import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { SourceFetcher } from "../src/discovery/ports.ts";
import { answered, extraction } from "./fixtures/processing/answers.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// An operator's own page about its own trips, through the pipeline: it is the page address of each trip, so a trip
// with booking open and no booking link can be booked through it.

const PAGE_URL = "https://www.hermanus-whale-cruises.co.za/trip.php";

const fetcher: SourceFetcher = {
  kind: "web_page",
  fetch: () =>
    Promise.resolve({
      listings: [
        {
          sourceListingId: PAGE_URL,
          url: PAGE_URL,
          contentType: "text/html",
          content: "<html><body><h3>THE BOAT TRIP</h3><p>Whale watching trips from the New Harbour.</p></body></html>",
        },
      ],
      complete: true,
      syncState: {},
    }),
};

// The two trips as the page gives them: daily from June to November, booking open, and no booking link.
const trip = (title: string) =>
  answered({
    title,
    type: "recurring",
    status: "confirmed",
    booking: "open",
    sessions: [],
    recurrence: { rule: "FREQ=DAILY", start: "2027-06-01", end: "2027-11-30", startTime: "09:00", endTime: "", skipped: [] },
    venueName: "New Harbour",
    url: "",
  });

const model = fakeLanguageModel({
  extract: () =>
    extraction(
      trip("Hermanus Whale Cruises boat-based whale watching"),
      trip("Hermanus Whale Cruises Eco Marine cruise"),
    ),
  classify: () => ({ attributes: [], tags: [], profile: "A boat trip to watch whales in Walker Bay." }),
});

let harness: Harness;

before(async () => {
  harness = await createHarness({ languageModel: model, fetchers: [fetcher] });
  const { catalogue, discovery } = harness.services;
  await catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "South Africa",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
  const source = await discovery.saveSource({
    name: "Hermanus Whale Cruises",
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [PAGE_URL], ownPages: true },
  });
  await discovery.runSource(source.id);
  await harness.services.dataProcessing.processPending();
});

after(async () => {
  await harness.close();
});

describe("An operator's own page", () => {
  test("is the page address of each trip on it, and a trip with booking open is bookable by it", async () => {
    const found = await harness.services.catalogue.searchExperiences({
      location: "hermanus",
      from: "2027-07-01",
      to: "2027-07-07",
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(
      found.items.map((item) => [item.title, item.pageUrl, item.bookingUrl, item.bookable]).sort(),
      [
        ["Hermanus Whale Cruises Eco Marine cruise", PAGE_URL, null, true],
        ["Hermanus Whale Cruises boat-based whale watching", PAGE_URL, null, true],
      ],
    );
  });
});
