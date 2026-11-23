import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  createExtractors,
  type ExtractInput,
  settleExperience,
  sourcingWindow,
  UnreadableListing,
} from "../src/data-processing/extract.ts";
import { EXTRACTION_INSTRUCTIONS } from "../src/data-processing/instructions.ts";
import type { Logger } from "../src/shared/logger.ts";
import { answered, extraction, session } from "./fixtures/processing/answers.ts";
import { HERMANUS, NOW } from "./fixtures/processing/fakes.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

function extractorFor(kind: string, answer = extraction()) {
  const model = fakeLanguageModel({ extract: [answer] });
  const extractor = createExtractors({ languageModel: model, horizonMonths: 24, logger: silent }).get(kind);
  if (!extractor) throw new Error(`no extractor for ${kind}`);
  return { extractor, model };
}

function input(overrides: Partial<ExtractInput> = {}): ExtractInput {
  return {
    content: "<html><body><p>FynArts</p></body></html>",
    contentType: "text/html",
    url: "https://fynarts.example.com/",
    fetchedAt: new Date(NOW),
    now: new Date(NOW),
    location: HERMANUS,
    ...overrides,
  };
}

function settled(overrides: Parameters<typeof answered>[0] = {}) {
  const result = settleExperience(answered(overrides), "https://fynarts.example.com/page");
  if ("problem" in result) throw new Error(result.problem);
  return result.experience;
}

function problemOf(overrides: Parameters<typeof answered>[0]): string {
  const result = settleExperience(answered(overrides), undefined);
  assert.ok("problem" in result, "expected the experience to be dropped");
  return result.problem;
}

describe("Extractors", () => {
  test("there is one for each kind that needs no key, and none for Quicket or Ticketmaster", () => {
    const extractors = createExtractors({ languageModel: fakeLanguageModel(), horizonMonths: 24, logger: silent });
    assert.deepEqual([...extractors.keys()].sort(), ["pdf_calendar", "rss_feed", "web_page"]);
  });

  test("a web page reaches the model as its visible text and structured data, with the context and instructions", async () => {
    const { extractor, model } = extractorFor("web_page");
    await extractor.extract(
      input({
        content:
          "<html><head><script>track()</script></head><body><h1>What's on</h1><p>FynArts, 12 June</p>" +
          '<script type="application/ld+json">{"@type":"Event","name":"FynArts"}</script></body></html>',
      }),
    );
    const [request] = model.of("extract");
    assert.ok(request);
    assert.equal(request.instructions, EXTRACTION_INSTRUCTIONS);
    assert.equal(request.document, undefined);
    assert.match(request.text, /Place: Hermanus, Western Cape, South Africa\. Its timezone is Africa\/Johannesburg\./);
    assert.match(request.text, /Fetched: 2026-11-23T08:00:00\.000Z, which is Monday, 23 November 2026 at 10:00 in Hermanus\./);
    assert.match(request.text, /leave out anything that starts after 2028-11-23/);
    assert.match(request.text, /The item is a web page, at https:\/\/fynarts\.example\.com\//);
    assert.match(request.text, /What's on\nFynArts, 12 June/);
    assert.match(request.text, /Structured data \(JSON-LD\):\n\{"@type":"Event","name":"FynArts"\}/);
    assert.doesNotMatch(request.text, /track\(\)/);
  });

  test("a web page's links to a map that carry coordinates reach the model after its structured data", async () => {
    const { extractor, model } = extractorFor("web_page");
    await extractor.extract(
      input({
        // As Quicket's event pages link to their venue.
        content:
          '<html><body><h1>Nomadic Orchestra</h1><a href="http://maps.google.co.za/maps?q=-34.3681325,18.8223162">' +
          'Directions</a><a href="https://www.google.com/maps/search/Hermanus">Map</a></body></html>',
      }),
    );
    const [request] = model.of("extract");
    assert.ok(request);
    assert.match(request.text, /Map links:\nhttp:\/\/maps\.google\.co\.za\/maps\?q=-34\.3681325,18\.8223162$/);
    assert.doesNotMatch(request.text, /maps\/search\/Hermanus/);
  });

  test("keeps a venue position the listing states near the location, and drops a far or impossible one with a warning", async () => {
    const warnings: unknown[] = [];
    const logger: Logger = { ...silent, warn: (fields) => warnings.push(fields) };
    const model = fakeLanguageModel({
      extract: [
        extraction(
          // Kleinmond, about 30 km from Hermanus.
          answered({ title: "Near", venueLatitude: -34.3395729, venueLongitude: 19.0191822 }),
          // Johannesburg.
          answered({ title: "Far", venueName: "Ellis Park", venueLatitude: -26.1975, venueLongitude: 28.0606 }),
          answered({ title: "Impossible", venueLatitude: -134.4, venueLongitude: 19.2 }),
          answered({ title: "Half", venueLatitude: -34.42, venueLongitude: null }),
        ),
      ],
    });
    const extractor = createExtractors({ languageModel: model, horizonMonths: 24, logger }).get("web_page");
    assert.ok(extractor);
    const experiences = await extractor.extract(input());
    assert.deepEqual(
      experiences.map((experience) => [experience.title, experience.venue]),
      [
        ["Near", { city: "Hermanus", position: { lat: -34.3395729, lng: 19.0191822 } }],
        ["Far", { name: "Ellis Park", city: "Hermanus" }],
        ["Impossible", { city: "Hermanus" }],
        ["Half", { city: "Hermanus" }],
      ],
    );
    assert.equal(warnings.length, 2);
    assert.match(JSON.stringify(warnings[0]), /km from Hermanus/);
    assert.match(JSON.stringify(warnings[1]), /is not a position/);
  });

  test("a feed post reaches the model as its title, link, date, categories and body as text", async () => {
    const { extractor, model } = extractorFor("rss_feed");
    await extractor.extract(
      input({
        contentType: "application/xml",
        content: `<item><title>Whale Festival returns</title><link>https://news.example.com/whales</link>
          <pubDate>Mon, 20 Sep 2027 08:00:00 +0000</pubDate><category>Events</category><category>Whales</category>
          <content:encoded><![CDATA[<p>The festival runs <b>24 to 26 September</b>.</p>]]></content:encoded></item>`,
      }),
    );
    const text = model.of("extract")[0]?.text ?? "";
    assert.match(text, /The item is a post from a news feed/);
    assert.match(text, /Title: Whale Festival returns\nLink: https:\/\/news\.example\.com\/whales\nPublished: Mon, 20 Sep 2027/);
    assert.match(text, /Categories: Events, Whales/);
    assert.match(text, /The festival runs 24 to 26 September\./);
    assert.doesNotMatch(text, /<b>/);
  });

  test("a feed item with no item in it cannot be read, and the model is not asked", async () => {
    const { extractor, model } = extractorFor("rss_feed");
    await assert.rejects(extractor.extract(input({ content: "not a feed at all" })), UnreadableListing);
    assert.equal(model.requests.length, 0);
  });

  test("a PDF calendar reaches the model as the document itself, with a short text", async () => {
    const { extractor, model } = extractorFor("pdf_calendar");
    await extractor.extract(input({ content: "JVBERi0xLjQK", contentType: "application/pdf" }));
    const [request] = model.of("extract");
    assert.deepEqual(request?.document, { mediaType: "application/pdf", base64: "JVBERi0xLjQK" });
    assert.match(request.text, /The item is a PDF calendar[\s\S]*The content is the attached PDF calendar\./);
  });

  test("returns the experiences in the doc's shape, with empty fields left out", async () => {
    const { extractor } = extractorFor("web_page", extraction(answered()));
    assert.deepEqual(await extractor.extract(input()), [
      {
        title: "Hermanus FynArts",
        summary: "A ten-day arts festival.",
        description: "Exhibitions, concerts and talks across Hermanus.",
        type: "single",
        status: "announced",
        booking: "not_yet",
        sessions: [{ start: "2027-06-12", end: "2027-06-21", precision: "day" }],
        venue: { city: "Hermanus" },
        hints: ["Festival"],
      },
    ]);
  });

  test("leaves out what is over at the fetch time or by now, and what starts beyond the horizon", async () => {
    const { extractor } = extractorFor(
      "web_page",
      extraction(
        answered({ title: "Last weekend", sessions: [session({ start: "2026-11-21", end: "2026-11-22" })] }),
        answered({ title: "Ends today", sessions: [session({ start: "2026-11-20", end: "2026-11-23" })] }),
        answered({ title: "Too far", sessions: [session({ start: "2028-11-24", end: "" })] }),
        answered({ title: "On the horizon", sessions: [session({ start: "2028-11-23", end: "" })] }),
        answered({
          title: "Every Saturday",
          type: "recurring",
          sessions: [],
          recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2020-01-04", end: "", startTime: "09:00", endTime: "", skipped: [] },
        }),
      ),
    );
    const titles = (await extractor.extract(input())).map((experience) => experience.title);
    assert.deepEqual(titles, ["Ends today", "On the horizon", "Every Saturday"]);
  });

  test("an experience that ended before today is over even when the page was fetched before it ended", async () => {
    const { extractor } = extractorFor(
      "web_page",
      extraction(answered({ sessions: [session({ start: "2026-11-20", end: "2026-11-21" })] })),
    );
    const found = await extractor.extract(
      input({ fetchedAt: new Date("2026-11-19T08:00:00Z"), now: new Date("2026-11-23T08:00:00Z") }),
    );
    assert.deepEqual(found, []);
  });

  test("drops an experience that cannot be repaired and keeps the others", async () => {
    const { extractor } = extractorFor(
      "web_page",
      extraction(answered({ title: "Broken", sessions: [session({ start: "2027-02-30" })] }), answered()),
    );
    assert.deepEqual((await extractor.extract(input())).map((experience) => experience.title), ["Hermanus FynArts"]);
  });

  test("an item is the own page of the one experience it describes, and of none when it lists several", async () => {
    const own = extractorFor("web_page", extraction(answered({ url: "https://fynarts.example.com/" })));
    assert.equal((await own.extractor.extract(input()))[0]?.url, "https://fynarts.example.com/");

    const listing = extractorFor(
      "web_page",
      extraction(
        answered({ url: "https://fynarts.example.com/" }),
        answered({ title: "Jazz on the Cliffs", url: "https://fynarts.example.com/jazz" }),
      ),
    );
    assert.deepEqual(
      (await listing.extractor.extract(input())).map((experience) => experience.url),
      [undefined, "https://fynarts.example.com/jazz"],
    );
  });
});

describe("The checks on each extracted experience", () => {
  test("dates must be real dates and an end must not be before its start", () => {
    assert.match(problemOf({ sessions: [session({ start: "2027-06-31", end: "" })] }), /not a date/);
    assert.match(problemOf({ sessions: [session({ start: "12 June", end: "" })] }), /not a date/);
    assert.match(problemOf({ sessions: [session({ start: "2027-06-12", end: "2027-06-10" })] }), /ends .* before it starts/);
  });

  test("a single has one session, a run has sessions, and a recurring experience has a recurrence", () => {
    assert.match(problemOf({ sessions: [session(), session({ start: "2027-07-01", end: "" })] }), /single .* 2 sessions/);
    assert.match(problemOf({ sessions: [] }), /single .* 0 sessions/);
    assert.match(problemOf({ type: "run", sessions: [] }), /run has no sessions/);
    assert.match(problemOf({ type: "recurring", sessions: [] }), /no recurrence/);
    assert.match(
      problemOf({
        recurrence: { rule: "FREQ=WEEKLY", start: "2027-01-02", end: "", startTime: "", endTime: "", skipped: [] },
      }),
      /single experience has a recurrence/,
    );
  });

  test("a recurrence needs a rule with a frequency and real dates; RRULE: is taken off", () => {
    const recurring = (rule: string) => ({
      type: "recurring" as const,
      sessions: [],
      recurrence: { rule, start: "2027-01-02", end: "", startTime: "09:00", endTime: "13:00", skipped: [" 2027-12-25 "] },
    });
    assert.match(problemOf(recurring("BYDAY=SA")), /not a recurrence rule/);
    assert.match(problemOf(recurring("every Saturday")), /not a recurrence rule/);
    assert.deepEqual(settled(recurring("RRULE:FREQ=WEEKLY;BYDAY=SA")).recurrence, {
      rule: "FREQ=WEEKLY;BYDAY=SA",
      start: "2027-01-02",
      startTime: "09:00",
      endTime: "13:00",
      skipped: ["2027-12-25"],
    });
  });

  test("a month or a year is one session on its boundaries, with no times", () => {
    assert.deepEqual(
      settled({ sessions: [session({ start: "2027-06", end: "", precision: "month", startTime: "19:00" })] }).sessions,
      [{ start: "2027-06-01", precision: "month" }],
    );
    assert.deepEqual(
      settled({ sessions: [session({ start: "2027-06-01", end: "2027-11-30", precision: "month" })] }).sessions,
      [{ start: "2027-06-01", end: "2027-11-30", precision: "month" }],
    );
    assert.deepEqual(settled({ sessions: [session({ start: "2027", end: "", precision: "year" })] }).sessions, [
      { start: "2027-01-01", precision: "year" },
    ]);
  });

  test("times are HH:MM, and a time that is not one drops the experience", () => {
    assert.deepEqual(
      settled({ sessions: [session({ end: "", startTime: "9:30", endTime: "17:00:00", label: "Opening" })] }).sessions,
      [{ start: "2027-06-12", precision: "day", startTime: "09:30", endTime: "17:00", label: "Opening" }],
    );
    assert.match(problemOf({ sessions: [session({ startTime: "evening" })] }), /not a time of day/);
  });

  test("booking fits the status: on sale means confirmed, and postponed or cancelled closes booking", () => {
    assert.deepEqual(
      [settled({ status: "announced", booking: "open" })].map(({ status, booking }) => ({ status, booking })),
      [{ status: "confirmed", booking: "open" }],
    );
    const cancelled = settled({ status: "cancelled", booking: "open" });
    assert.equal(cancelled.booking, "closed");
    assert.equal(settled({ status: "postponed", booking: "none" }).booking, "none");
  });

  test("prices, timestamps and links are kept only when they are what they say", () => {
    const experience = settled({
      priceMin: 150,
      priceMax: -1,
      currency: "zar",
      onSaleAt: "2027-03-01T09:00:00+02:00",
      bookingClosesAt: "2027-06-11",
      bookingUrl: "/tickets",
      imageUrl: "javascript:alert(1)",
      url: "https://fynarts.example.com/2027",
    });
    assert.deepEqual(experience.price, { min: 150, currency: "ZAR" });
    assert.equal(experience.onSaleAt, "2027-03-01T07:00:00.000Z");
    assert.equal(experience.bookingClosesAt, undefined);
    assert.equal(experience.bookingUrl, "https://fynarts.example.com/tickets");
    assert.equal(experience.imageUrl, undefined);
    assert.equal(experience.url, "https://fynarts.example.com/2027");
  });

  test("an experience with no title is dropped", () => {
    assert.match(problemOf({ title: "  " }), /no title/);
  });
});

describe("A title that names no experience", () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), "utf8");

  test("is dropped with a warning when it is only the place and a year, or a label of the page", async () => {
    const warnings: unknown[] = [];
    const logger: Logger = { ...silent, warn: (fields) => warnings.push(fields) };
    // What a real run returned for AllEvents.in's pages, whose own names for the events are "Time" and
    // "Hermanus 2026", and the name the instructions now ask for.
    const model = fakeLanguageModel({
      extract: [
        extraction(
          answered({
            title: "Time",
            city: "Hawston",
            sessions: [session({ start: "2026-12-05", end: "", startTime: "06:45" })],
          }),
          answered({ title: "Hermanus 2026", sessions: [session({ start: "2026-11-27", end: "2026-11-29" })] }),
          answered({ title: "What's On: Hermanus, December", sessions: [session({ start: "2026-12-12", end: "" })] }),
          answered({
            title: "Atlantic Flying Club slope soaring weekend",
            sessions: [session({ start: "2026-11-27", end: "2026-11-29" })],
          }),
        ),
      ],
    });
    const extractor = createExtractors({ languageModel: model, horizonMonths: 24, logger }).get("web_page");
    assert.ok(extractor);
    const experiences = await extractor.extract(
      input({
        content: fixture("allevents-time.txt") + fixture("allevents-hermanus-2026.txt"),
        contentType: "text/plain",
      }),
    );
    assert.deepEqual(
      experiences.map((experience) => experience.title),
      ["Atlantic Flying Club slope soaring weekend"],
    );
    assert.equal(warnings.length, 3);
    assert.match(JSON.stringify(warnings[0]), /names no experience/);
  });

  test("the instructions leave out seasons and ask for a title that names the experience", () => {
    assert.match(EXTRACTION_INSTRUCTIONS, /A season or a natural spectacle/);
    assert.doesNotMatch(EXTRACTION_INSTRUCTIONS, /A season with months and no date/);
    assert.match(EXTRACTION_INSTRUCTIONS, /A title must name the experience/);
  });
});

describe("An event that structured data gives one start and one end", () => {
  // Quicket's search page for Hermanus as fetched on 23 November 2026, cut to four of its events. Its visible text
  // is empty: the events are in its structured data and nowhere else.
  const searchPage = readFileSync(new URL("./fixtures/sources/quicket-search.html", import.meta.url), "utf8");
  const quicket = (id: string) => `https://www.quicket.co.za/events/${id}/`;

  // What a model that copies the structured data's start and end into one session answers.
  const copied = extraction(
    answered({
      title: "Sip & Solve: Blind Wine & Whisky Tasting",
      sessions: [session({ start: "2026-12-19", end: "2026-12-30", startTime: "18:30", endTime: "21:00" })],
      url: quicket("408111-sip-solve-blind-wine-whisky-tasting"),
    }),
    answered({
      title: "BNC#10 - The 2027 BizNews Conference in Hermanus",
      sessions: [session({ start: "2027-03-08", end: "2027-03-12", startTime: "15:00", endTime: "13:00" })],
      url: quicket("405764-bnc10-the-2027-biznews-conference-in-hermanus"),
    }),
    answered({
      title: "Grip Gymnastics and Dance Concert",
      sessions: [session({ start: "2026-11-28", end: "2026-11-29", startTime: "10:00", endTime: "16:45" })],
      url: quicket("380987-grip-gymnastics-and-dance-concert-2026"),
    }),
    answered({
      title: "Hidden Gems Wine Festival",
      sessions: [session({ start: "2026-12-20", end: "", startTime: "11:00", endTime: "17:00" })],
      url: quicket("401916-hidden-gems-wine-festival"),
    }),
  );

  test("is on only the first and the last day when nothing else gives its dates", async () => {
    const { extractor } = extractorFor("web_page", copied);
    const experiences = await extractor.extract(
      input({ content: searchPage, url: "https://www.quicket.co.za/events/south-africa?search=hermanus" }),
    );
    assert.deepEqual(
      experiences.map((experience) => [experience.title, experience.type, experience.sessions]),
      [
        [
          "Sip & Solve: Blind Wine & Whisky Tasting",
          "run",
          [
            { start: "2026-12-19", precision: "day", startTime: "18:30" },
            { start: "2026-12-30", precision: "day", endTime: "21:00" },
          ],
        ],
        // It ends at an earlier time of day than it starts, so it runs through.
        [
          "BNC#10 - The 2027 BizNews Conference in Hermanus",
          "single",
          [{ start: "2027-03-08", end: "2027-03-12", precision: "day", startTime: "15:00", endTime: "13:00" }],
        ],
        // Matched by its page, though the model left the year out of the title.
        [
          "Grip Gymnastics and Dance Concert",
          "run",
          [
            { start: "2026-11-28", precision: "day", startTime: "10:00" },
            { start: "2026-11-29", precision: "day", endTime: "16:45" },
          ],
        ],
        [
          "Hidden Gems Wine Festival",
          "single",
          [{ start: "2026-12-20", precision: "day", startTime: "11:00", endTime: "17:00" }],
        ],
      ],
    );
  });

  test("is left as the model read it when the page's text speaks of the event", async () => {
    const page = searchPage.replace(
      "<main",
      "<p>Sip & Solve: Blind Wine & Whisky Tasting, every evening from 19 to 30 December.</p><main",
    );
    const { extractor } = extractorFor("web_page", copied);
    const [sipAndSolve] = await extractor.extract(input({ content: page }));
    assert.equal(sipAndSolve?.type, "single");
    assert.deepEqual(sipAndSolve.sessions.map((one) => [one.start, one.end]), [["2026-12-19", "2026-12-30"]]);
  });
});

describe("The sourcing window", () => {
  test("is counted in the location's days: a fetch late on the 22nd UTC is the 23rd in Hermanus", () => {
    assert.deepEqual(
      sourcingWindow({
        fetchedAt: new Date("2026-11-22T23:30:00Z"),
        now: new Date("2026-11-22T23:30:00Z"),
        timezone: "Africa/Johannesburg",
        horizonMonths: 24,
      }),
      { overBefore: "2026-11-23", fetchDay: "2026-11-23", horizonEnd: "2028-11-23" },
    );
  });
});
