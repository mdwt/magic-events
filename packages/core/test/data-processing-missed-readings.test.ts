import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { events, experience, experienceSourceLink } from "@magic-events/db";
import { asc, eq } from "drizzle-orm";
import type { Source, SourceFetcher } from "../src/discovery/ports.ts";
import type { LanguageModelRequest } from "../src/shared/language-model.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";
import { answered, extraction, session } from "./fixtures/processing/answers.ts";

// The whole pipeline against the database: a calendar page lists a whale festival and a jazz night, and some
// readings of it do not yield the jazz night: an empty page once, then a page with the festival alone. The jazz
// night keeps its link and its status until three readings in a row have missed it, the source's missed runs
// before removal.

const PAGE_URL = "https://calendar.example.com/";
// What the page lists in the reading to come, and a counter so each reading is a new version of the page.
let lists: ("whales" | "jazz")[] = ["whales", "jazz"];
let reading = 0;

const fetcher: SourceFetcher = {
  kind: "web_page",
  fetch: () =>
    Promise.resolve({
      listings: [
        {
          sourceListingId: PAGE_URL,
          url: PAGE_URL,
          contentType: "text/html",
          content: `<html><body><p>Reading ${String(reading)}</p>${lists.map((one) => `<p>Listed: ${one}</p>`).join("")}</body></html>`,
        },
      ],
      complete: true,
      syncState: {},
    }),
};

const WHALES = answered({ title: "Whale Festival", sessions: [session({ start: "2027-09-24", end: "2027-09-26" })] });
const JAZZ = answered({ title: "Jazz Night", sessions: [session({ start: "2027-07-10", end: "" })] });

const model = fakeLanguageModel({
  extract: (request: LanguageModelRequest<unknown>) =>
    extraction(
      ...(request.text.includes("Listed: whales") ? [WHALES] : []),
      ...(request.text.includes("Listed: jazz") ? [JAZZ] : []),
    ),
  classify: () => ({ attributes: [], tags: [], profile: "An evening out." }),
});

let harness: Harness;
let source: Source;
let minutes = 0;
const clock = () => new Date(Date.parse("2026-11-23T08:00:00Z") + minutes++ * 60_000);

before(async () => {
  harness = await createHarness({ languageModel: model, fetchers: [fetcher], clock });
  await harness.services.catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "South Africa",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
  source = await harness.services.discovery.saveSource({
    name: "Town calendar",
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [PAGE_URL] },
    missedRunsBeforeRemoval: 3,
  });
});

after(async () => {
  await harness.close();
});

// Fetches the page as it now lists, and processes it.
async function read(listed: ("whales" | "jazz")[]) {
  lists = listed;
  reading += 1;
  await harness.services.discovery.runSource(source.id);
  const outcomes = await harness.services.dataProcessing.processPending();
  assert.deepEqual(
    outcomes.map((one) => one.outcome),
    ["processed"],
  );
  return outcomes[0];
}

async function jazz() {
  const [row] = await harness.db
    .select({ id: experience.id, status: experience.status, version: experience.version })
    .from(experience)
    .where(eq(experience.title, "Jazz Night"));
  assert.ok(row);
  const links = await harness.db
    .select({ missed: experienceSourceLink.missedReadings })
    .from(experienceSourceLink)
    .where(eq(experienceSourceLink.experienceId, row.id));
  return { status: row.status, version: row.version, links: links.map((link) => link.missed) };
}

async function changedEvents(): Promise<number> {
  return (await harness.db.select().from(events).where(eq(events.type, "experience.changed")).orderBy(asc(events.recordedAt)))
    .length;
}

describe("an experience a listing no longer yields", () => {
  test("an empty page once removes nothing, and a reading that yields it again sets the count back", async () => {
    await read(["whales", "jazz"]);
    assert.deepEqual(await jazz(), { status: "announced", version: 1, links: [0] });

    // Read as nothing at all: both are missed once, and both keep their links.
    const empty = await read([]);
    assert.equal(empty?.unlinked, 0);
    assert.deepEqual(await jazz(), { status: "announced", version: 1, links: [1] });

    await read(["whales"]);
    assert.deepEqual(await jazz(), { status: "announced", version: 1, links: [2] });

    // It is back: the count is set back, and it is no change.
    await read(["whales", "jazz"]);
    assert.deepEqual(await jazz(), { status: "announced", version: 1, links: [0] });
    assert.equal(await changedEvents(), 0);
  });

  test("keeps its link and status through two readings without it, and loses the link on the third", async () => {
    for (const missed of [1, 2]) {
      const outcome = await read(["whales"]);
      assert.equal(outcome?.unlinked, 0);
      assert.deepEqual(await jazz(), { status: "announced", version: 1, links: [missed] });
    }
    assert.equal(await changedEvents(), 0);

    const third = await read(["whales"]);
    assert.equal(third?.unlinked, 1);
    assert.deepEqual(await jazz(), { status: "removed", version: 2, links: [] });
    assert.equal(await changedEvents(), 1);
  });
});
