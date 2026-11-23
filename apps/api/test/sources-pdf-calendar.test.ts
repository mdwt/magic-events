import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Location } from "../src/core/catalogue/ports.ts";
import type { FetchInput } from "../src/core/discovery/ports.ts";
import type { LanguageModel, LanguageModelRequest } from "../src/core/shared/language-model.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import { createHttp } from "../src/adapters/sources/http.ts";
import { createPdfCalendarFetcher, pageLinks } from "../src/adapters/sources/pdf-calendar.ts";
import { fixture, startFixtureServer, type FixtureServer } from "./fixtures/sources/server.ts";

// The PDF calendar adapter against a local server serving a recorded calendar page and a small PDF, with a fake
// language model that picks a link.

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

const hermanus: Location = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Hermanus",
  slug: "hermanus",
  country: "South Africa",
  region: "Western Cape",
  timezone: "Africa/Johannesburg",
  latitude: -34.4187,
  longitude: 19.2345,
};

function input(settings: Record<string, unknown>): FetchInput {
  return { settings, location: hermanus, syncState: {}, window: { from: "2026-11-23", to: "2028-11-23" } };
}

// A language model that answers with the link whose text the test names, through the schema it is given.
function pickingModel(answer: (links: string) => unknown) {
  const requests: LanguageModelRequest<unknown>[] = [];
  const model: LanguageModel = {
    ask<T>(request: LanguageModelRequest<T>): Promise<T> {
      requests.push(request);
      return Promise.resolve(request.schema.parse(answer(request.text)));
    },
  };
  return { model, requests };
}

function linkFor(text: string, label: string): string | null {
  const line = text.split("\n").find((one) => one.startsWith(`- ${label}: `));
  return line === undefined ? null : line.slice(`- ${label}: `.length);
}

const http = createHttp({ timeoutSeconds: 5, userAgent: "magic-events-test/1.0" });
let server: FixtureServer;

before(async () => {
  server = await startFixtureServer();
  server.route("/events-calendar/", { body: fixture("calendar.html") });
  server.route("/wp-content/uploads/2026/11/November-Events-2026-v2.pdf", {
    type: "application/pdf",
    body: fixture("calendar.pdf"),
  });
  server.route("/wp-content/uploads/2025/12/Annual-Events-2026.pdf", { type: "application/pdf", body: "<html>" });
  server.route("/no-links/", { body: "<html><body><p>Nothing here</p></body></html>" });
});

after(async () => {
  await server.close();
});

describe("pdf_calendar adapter", () => {
  test("asks the model for the current file of the calendar and returns it as base64", async () => {
    const { model, requests } = pickingModel((text) => ({ url: linkFor(text, "November Events / November Events (print)") }));
    const fetcher = createPdfCalendarFetcher({ http, languageModel: model, logger: silent });

    const result = await fetcher.fetch(
      input({ pageUrl: server.url("/events-calendar/"), calendarName: "November Events" }),
    );

    assert.equal(result.complete, true);
    assert.equal(result.listings.length, 1);
    const [listing] = result.listings;
    assert.equal(listing?.sourceListingId, "November Events");
    assert.equal(listing.url, server.url("/wp-content/uploads/2026/11/November-Events-2026-v2.pdf"));
    assert.equal(listing.contentType, "application/pdf");
    assert.deepEqual(Buffer.from(listing.content, "base64"), fixture("calendar.pdf"));

    // One question, with the calendar's name, today and every web link on the page once.
    assert.equal(requests.length, 1);
    const text = requests[0]?.text ?? "";
    assert.match(text, /^Calendar: November Events$/m);
    assert.match(text, /^Today: 2026-11-23$/m);
    assert.match(text, /Annual events: http:\/\/127\.0\.0\.1:\d+\/wp-content\/uploads\/2025\/12\/Annual-Events-2026\.pdf/);
    assert.equal(text.match(/November-Events-2026-v2\.pdf/g)?.length, 1);
    assert.doesNotMatch(text, /mailto:|javascript:/);
  });

  test("fails when the model names an address that is not a link on the page", async () => {
    const { model } = pickingModel(() => ({ url: "https://whalecoast.example.com/made-up.pdf" }));
    const fetcher = createPdfCalendarFetcher({ http, languageModel: model, logger: silent });

    await assert.rejects(
      fetcher.fetch(input({ pageUrl: server.url("/events-calendar/"), calendarName: "November Events" })),
      /named https:\/\/whalecoast\.example\.com\/made-up\.pdf, which is not a link on/,
    );
  });

  test("fails when the model finds no file of the calendar", async () => {
    const { model } = pickingModel(() => ({ url: null }));
    const fetcher = createPdfCalendarFetcher({ http, languageModel: model, logger: silent });

    await assert.rejects(
      fetcher.fetch(input({ pageUrl: server.url("/events-calendar/"), calendarName: "December Events" })),
      /found no file of the calendar "December Events"/,
    );
  });

  test("fails when the file picked is not a PDF", async () => {
    const { model } = pickingModel((text) => ({ url: linkFor(text, "Annual events") }));
    const fetcher = createPdfCalendarFetcher({ http, languageModel: model, logger: silent });

    await assert.rejects(
      fetcher.fetch(input({ pageUrl: server.url("/events-calendar/"), calendarName: "Annual events" })),
      /is not a PDF/,
    );
  });

  test("fails without asking the model when the page has no links", async () => {
    const { model, requests } = pickingModel(() => ({ url: null }));
    const fetcher = createPdfCalendarFetcher({ http, languageModel: model, logger: silent });

    await assert.rejects(
      fetcher.fetch(input({ pageUrl: server.url("/no-links/"), calendarName: "Annual events" })),
      /has no links/,
    );
    assert.equal(requests.length, 0);
  });

  test("fails with what is wrong when the settings are wrong", async () => {
    const { model } = pickingModel(() => ({ url: null }));
    const fetcher = createPdfCalendarFetcher({ http, languageModel: model, logger: silent });

    await assert.rejects(
      fetcher.fetch(input({ pageUrl: server.url("/events-calendar/") })),
      /The pdf_calendar settings are wrong: calendarName/,
    );
  });

  test("collects each web link once, by its absolute address, with the texts it is shown with", () => {
    const links = pageLinks(fixture("calendar.html").toString("utf8"), "https://whalecoast.example.com/events-calendar/");
    assert.deepEqual(links.at(2), {
      url: "https://whalecoast.example.com/wp-content/uploads/2025/12/Annual-Events-2026.pdf",
      text: "Annual events",
    });
    assert.equal(links.filter((link) => link.url.includes("November")).length, 1);
    assert.ok(links.every((link) => link.url.startsWith("https://")));
  });
});
