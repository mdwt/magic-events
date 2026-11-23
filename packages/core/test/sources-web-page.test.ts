import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { Location } from "../src/catalogue/ports.ts";
import type { FetchInput, FetchedListing } from "../src/discovery/ports.ts";
import type { Logger } from "../src/shared/logger.ts";
import { createHttp } from "../src/adapters/sources/http.ts";
import { createWebPageFetcher } from "../src/adapters/sources/web-page.ts";
import { pageContent, sharedLines } from "../src/shared/html.ts";
import { fixture, startFixtureServer, type FixtureServer } from "./fixtures/sources/server.ts";

// The web page adapter against a local server serving recorded pages.

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

// The fingerprint Discovery takes from a listing.
function print(listing: FetchedListing | undefined): string {
  assert.ok(listing);
  return createHash("sha256")
    .update(listing.fingerprintOf ?? listing.content)
    .digest("hex");
}

// A page whose event card carries its price in the card's own footer.
function ticketPage(price: string): string {
  return (
    "<html><body><nav>Home</nav><main><article><h2>Whale Coast Jazz</h2><p>Saturday 5 December 2026</p>" +
    `<footer>Tickets ${price}</footer></article></main><footer>© Example</footer></body></html>`
  );
}

const villageNews = readdirSync(new URL("fixtures/sources/village-news/first/", import.meta.url)).sort();

// The Village NEWS pages of one run, the first from another run when it is given.
function villageNewsRun(run: string, firstFrom = run): string[] {
  return villageNews.map((name, index) => server.url(`/village-news/${index === 0 ? firstFrom : run}/${name}`));
}

let server: FixtureServer;
const fetcher = createWebPageFetcher({
  http: createHttp({ timeoutSeconds: 5, userAgent: "magic-events-test/1.0" }),
  logger: silent,
});

before(async () => {
  server = await startFixtureServer();
  server.route("/weekend", { body: fixture("page.html"), gzip: true });
  server.route("/weekend-noise", { body: fixture("page-noise.html") });
  server.route("/weekend-changed", { body: fixture("page-changed.html") });
  server.route("/shell", { body: fixture("listing-shell.html") });
  server.route("/shell-changed", { body: fixture("listing-shell-changed.html") });
  // Two fetches of AllEvents.in's Hermanus page a minute apart, cut down: its footer's lists change on every fetch.
  server.route("/allevents", { body: fixture("allevents.html") });
  server.route("/allevents-refetched", { body: fixture("allevents-refetched.html") });
  server.route("/allevents-changed", { body: fixture("allevents-changed.html") });
  // Two renders of the FynArts event list, a Wix page, cut down: its render-time script differs.
  server.route("/wix", { body: fixture("wix-event-list.html") });
  server.route("/wix-rerendered", { body: fixture("wix-event-list-rerendered.html") });
  server.route("/ticket-footer", { body: ticketPage("R150") });
  server.route("/ticket-footer-changed", { body: ticketPage("R180") });
  // Ten of The Village NEWS's event pages, fetched twice three minutes apart, cut down: the ticker of today's
  // weather and tides at the top of every page changed its wind between the fetches.
  for (const run of ["first", "second"]) {
    for (const name of villageNews) server.route(`/village-news/${run}/${name}`, { body: fixture(`village-news/${run}/${name}`) });
  }
  const moved = fixture(`village-news/second/${villageNews[0] ?? ""}`).toString("utf8").replaceAll("3 December", "4 December");
  server.route(`/village-news/moved/${villageNews[0] ?? ""}`, { body: moved });
  // Two fetches of Stanford Tourism's event page, cut down: its JSON-LD writes the organiser's email address with
  // different HTML entities each time.
  server.route("/wordpress-event", { body: fixture("wordpress-event.html") });
  server.route("/wordpress-event-refetched", { body: fixture("wordpress-event-refetched.html") });
  // Two fetches of the Hermanus Golf Club's Google calendar, cut down: a new DTSTAMP and a new order each time.
  const calendar = { type: "text/calendar; charset=utf-8" };
  server.route("/calendar", { ...calendar, body: fixture("golf-calendar.ics") });
  server.route("/calendar-refetched", { ...calendar, body: fixture("golf-calendar-refetched.ics") });
  const calendarMoved = fixture("golf-calendar-refetched.ics").toString("utf8").replace("DTSTART;VALUE=DATE:20260828", "DTSTART;VALUE=DATE:20260829");
  server.route("/calendar-moved", { ...calendar, body: calendarMoved });
  server.route("/old-address", { redirectTo: "/weekend" });
  server.route("/gone", { status: 410, body: "Gone" });
  server.route("/broken", { status: 500, body: "Internal error" });
});

after(async () => {
  await server.close();
});

describe("web_page adapter", () => {
  test("returns one listing per address, the HTML as returned, and a complete run", async () => {
    const url = server.url("/weekend");
    const result = await fetcher.fetch(input({ urls: [url] }));

    assert.equal(result.complete, true);
    assert.equal(result.listings.length, 1);
    const [listing] = result.listings;
    assert.equal(listing?.sourceListingId, url);
    assert.equal(listing.url, url);
    assert.equal(listing.contentType, "text/html");
    assert.equal(listing.content, fixture("page.html").toString("utf8"));
    assert.match(listing.fingerprintOf ?? "", /Fernkloof Flower Show/);
    assert.doesNotMatch(listing.fingerprintOf ?? "", /__token/);
  });

  test("keeps the fingerprint when only the markup changes, and changes it when the text does", async () => {
    const result = await fetcher.fetch(
      input({ urls: [server.url("/weekend"), server.url("/weekend-noise"), server.url("/weekend-changed")] }),
    );
    const [page, noise, changed] = result.listings;

    assert.notEqual(page?.content, noise?.content);
    assert.equal(print(page), print(noise));
    assert.notEqual(print(page), print(changed));
  });

  test("a page whose events are only in its structured data changes its fingerprint when they change", async () => {
    const result = await fetcher.fetch(input({ urls: [server.url("/shell"), server.url("/shell-changed")] }));
    const [shell, changed] = result.listings;

    assert.match(shell?.fingerprintOf ?? "", /Whale Coast Jazz/);
    assert.notEqual(print(shell), print(changed));
  });

  test("keeps the fingerprint when only the site's frame changes, and changes it when an event's date does", async () => {
    const result = await fetcher.fetch(
      input({ urls: [server.url("/allevents"), server.url("/allevents-refetched"), server.url("/allevents-changed")] }),
    );
    const [page, refetched, changed] = result.listings;

    assert.notEqual(pageContent(page?.content ?? ""), pageContent(refetched?.content ?? ""));
    assert.equal(print(page), print(refetched));
    assert.notEqual(print(page), print(changed));
    assert.match(page?.fingerprintOf ?? "", /Rumours of Fleetwood Mac Tribute/);
    assert.doesNotMatch(page?.fingerprintOf ?? "", /Trending Searches/);
  });

  test("the language model is still given the site's frame", async () => {
    const result = await fetcher.fetch(input({ urls: [server.url("/allevents")] }));

    assert.match(pageContent(result.listings[0]?.content ?? ""), /Upcoming Events in Hermanus/);
  });

  test("keeps the fingerprint of a Wix page rendered again", async () => {
    const result = await fetcher.fetch(input({ urls: [server.url("/wix"), server.url("/wix-rerendered")] }));
    const [page, rerendered] = result.listings;

    assert.notEqual(page?.content, rerendered?.content);
    assert.equal(print(page), print(rerendered));
    assert.match(page?.fingerprintOf ?? "", /2027 Hermanus FynArts Festival/);
  });

  test("a footer inside the page's content is part of its fingerprint", async () => {
    const result = await fetcher.fetch(
      input({ urls: [server.url("/ticket-footer"), server.url("/ticket-footer-changed")] }),
    );
    const [page, changed] = result.listings;

    assert.match(page?.fingerprintOf ?? "", /Tickets R150/);
    assert.doesNotMatch(page?.fingerprintOf ?? "", /© Example/);
    assert.notEqual(print(page), print(changed));
  });

  test("keeps the fingerprints when only the lines every page of the site shows change", async () => {
    const first = await fetcher.fetch(input({ urls: villageNewsRun("first") }));
    const second = await fetcher.fetch(input({ urls: villageNewsRun("second") }));

    assert.equal(first.listings.length, 10);
    assert.notEqual(pageContent(first.listings[0]?.content ?? ""), pageContent(second.listings[0]?.content ?? ""));
    assert.deepEqual(first.listings.map(print), second.listings.map(print));
    assert.doesNotMatch(first.listings[0]?.fingerprintOf ?? "", /High tide/);
    assert.match(first.listings[0]?.fingerprintOf ?? "", /Jingle Bell Rock/);
  });

  test("a page whose own date changes changes its fingerprint, and the other pages keep theirs", async () => {
    const before = await fetcher.fetch(input({ urls: villageNewsRun("second") }));
    const after = await fetcher.fetch(input({ urls: villageNewsRun("second", "moved") }));
    const [moved, ...rest] = after.listings;
    const [original, ...others] = before.listings;

    assert.notEqual(print(moved), print(original));
    assert.deepEqual(rest.map(print), others.map(print));
  });

  test("fewer than ten pages fetched together share no lines, so a line on all of them still counts", () => {
    const pages = villageNews.map((name) => fixture(`village-news/first/${name}`).toString("utf8"));

    assert.ok(sharedLines(pages).size > 0);
    assert.equal(sharedLines(pages.slice(0, 9)).size, 0);
  });

  test("decodes the entities in structured data, so the same text written two ways reads the same", async () => {
    const result = await fetcher.fetch(
      input({ urls: [server.url("/wordpress-event"), server.url("/wordpress-event-refetched")] }),
    );
    const [page, refetched] = result.listings;

    assert.notEqual(page?.content, refetched?.content);
    assert.equal(print(page), print(refetched));
    assert.equal(pageContent(page?.content ?? ""), pageContent(refetched?.content ?? ""));
    assert.match(pageContent(page?.content ?? ""), /"email":"info@stanfordinbloom\.co\.za"/);
  });

  test("reads a calendar file without its DTSTAMP and with its events in a fixed order", async () => {
    const result = await fetcher.fetch(input({ urls: [server.url("/calendar"), server.url("/calendar-refetched")] }));
    const [first, refetched] = result.listings;
    const text = pageContent(first?.content ?? "");

    assert.notEqual(first?.content, refetched?.content);
    assert.equal(print(first), print(refetched));
    assert.equal(text, pageContent(refetched?.content ?? ""));
    assert.doesNotMatch(text, /DTSTAMP/);
    assert.equal(text.match(/^BEGIN:VEVENT$/gm)?.length, 17);
    assert.match(text, /^SUMMARY:Ladies Competition: Individual Bogey Plus - Enid Metcalf Trophy$/m);
    assert.match(text, /^RECURRENCE-ID;VALUE=DATE:/m);
  });

  test("a calendar event whose date changes changes the calendar's fingerprint", async () => {
    const result = await fetcher.fetch(input({ urls: [server.url("/calendar-refetched"), server.url("/calendar-moved")] }));
    const [before, moved] = result.listings;

    assert.notEqual(print(before), print(moved));
  });

  test("follows a redirect and keeps the address it was given", async () => {
    const url = server.url("/old-address");
    const result = await fetcher.fetch(input({ urls: [url] }));

    assert.equal(result.listings[0]?.sourceListingId, url);
    assert.match(result.listings[0].content, /Top things to do/);
  });

  test("leaves out an address that answers not found or gone, and the run is still complete", async () => {
    const result = await fetcher.fetch(
      input({ urls: [server.url("/weekend"), server.url("/no-such-page"), server.url("/gone")] }),
    );

    assert.equal(result.complete, true);
    assert.deepEqual(
      result.listings.map((listing) => listing.sourceListingId),
      [server.url("/weekend")],
    );
  });

  test("fails on any other answer", async () => {
    await assert.rejects(
      fetcher.fetch(input({ urls: [server.url("/weekend"), server.url("/broken")] })),
      /\/broken answered 500/,
    );
  });

  test("fails with what is wrong when the settings are wrong", async () => {
    await assert.rejects(fetcher.fetch(input({ urls: [] })), /The web_page settings are wrong: urls/);
    await assert.rejects(fetcher.fetch(input({ url: server.url("/weekend") })), /The web_page settings are wrong/);
  });
});
