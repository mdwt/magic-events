import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Location } from "../src/core/catalogue/ports.ts";
import type { FetchInput } from "../src/core/discovery/ports.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import { createHttp } from "../src/adapters/sources/http.ts";
import { createRssFeedFetcher } from "../src/adapters/sources/rss-feed.ts";
import { fixture, startFixtureServer, type FixtureServer } from "./fixtures/sources/server.ts";

// The RSS feed adapter against a local server serving recorded feeds.

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

let server: FixtureServer;
const fetcher = createRssFeedFetcher({
  http: createHttp({ timeoutSeconds: 5, userAgent: "magic-events-test/1.0" }),
  logger: silent,
});

before(async () => {
  server = await startFixtureServer();
  const xml = "application/rss+xml; charset=UTF-8";
  server.route("/hermanustimes/feed/", { type: xml, body: fixture("rss-page-1.xml"), gzip: true });
  server.route("/hermanustimes/feed/?paged=2", { type: xml, body: fixture("rss-page-2.xml") });
  // WordPress answers not found past the last page.
  server.route("/hermanustimes/feed/?paged=3", { status: 404, body: "<h1>Not found</h1>" });
  server.route("/arts/feed.atom", { type: "application/atom+xml", body: fixture("atom.xml") });
  server.route("/not-a-feed", { type: "text/html", body: "<html><body>Hello</body></html>" });
});

after(async () => {
  await server.close();
});

describe("rss_feed adapter", () => {
  test("returns one listing per item of the first page, each its own XML as in the feed", async () => {
    const result = await fetcher.fetch(input({ feedUrl: server.url("/hermanustimes/feed/") }));

    assert.equal(result.complete, false);
    assert.deepEqual(result.syncState, {});
    assert.equal(result.listings.length, 2);
    const [first] = result.listings;
    assert.ok(first);
    assert.equal(first.sourceListingId, "https://novanews.co.za/hermanustimes/?p=1201");
    assert.equal(first.url, "https://novanews.co.za/hermanustimes/fynarts-2027-programme-announced/");
    assert.equal(first.contentType, "application/xml");
    assert.equal(first.fingerprintOf, undefined);

    // Exactly the item's part of the feed, with the post's full text.
    const feed = fixture("rss-page-1.xml").toString("utf8");
    assert.ok(feed.includes(first.content));
    assert.ok(first.content.startsWith("<item>"));
    assert.ok(first.content.endsWith("</item>"));
    assert.match(first.content, /Tickets go on sale in March/);
    assert.equal(server.requests.at(-1)?.headers["user-agent"], "magic-events-test/1.0");
  });

  test("follows ?paged=N while pages return items, up to maxPages", async () => {
    const result = await fetcher.fetch(input({ feedUrl: server.url("/hermanustimes/feed/"), maxPages: 5 }));

    assert.deepEqual(
      result.listings.map((listing) => listing.sourceListingId),
      [
        "https://novanews.co.za/hermanustimes/?p=1201",
        "https://novanews.co.za/hermanustimes/?p=1200",
        "https://novanews.co.za/hermanustimes/?p=1199",
        // An item with no GUID is known by its link.
        "https://novanews.co.za/hermanustimes/a-post-with-no-guid/",
      ],
    );
  });

  test("stops at maxPages", async () => {
    const before = server.requests.length;
    await fetcher.fetch(input({ feedUrl: server.url("/hermanustimes/feed/"), maxPages: 2 }));
    assert.deepEqual(
      server.requests.slice(before).map((request) => request.path),
      ["/hermanustimes/feed/", "/hermanustimes/feed/?paged=2"],
    );
  });

  test("reads an Atom feed: the entry's ID and its alternate link", async () => {
    const result = await fetcher.fetch(input({ feedUrl: server.url("/arts/feed.atom") }));

    assert.deepEqual(
      result.listings.map((listing) => [listing.sourceListingId, listing.url]),
      [
        ["tag:arts.example.com,2026:open-studios", "https://arts.example.com/open-studios"],
        ["tag:arts.example.com,2026:jazz", "https://arts.example.com/jazz"],
      ],
    );
    const [first] = result.listings;
    assert.ok(first);
    assert.ok(first.content.startsWith("<entry>"));
    assert.ok(first.content.endsWith("</entry>"));
    assert.match(first.content, /&lt;p&gt;Open studios/);
  });

  test("fails when the first page is not found", async () => {
    await assert.rejects(fetcher.fetch(input({ feedUrl: server.url("/missing/feed/") })), /answered 404/);
  });

  test("fails when the address is not a feed", async () => {
    await assert.rejects(fetcher.fetch(input({ feedUrl: server.url("/not-a-feed") })), /neither an RSS 2.0 nor an Atom/);
  });

  test("fails with what is wrong when the settings are wrong", async () => {
    await assert.rejects(fetcher.fetch(input({ feedUrl: "not a url" })), /The rss_feed settings are wrong: feedUrl/);
    await assert.rejects(
      fetcher.fetch(input({ feedUrl: server.url("/hermanustimes/feed/"), pages: 2 })),
      /The rss_feed settings are wrong/,
    );
  });
});
