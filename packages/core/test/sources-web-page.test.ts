import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Location } from "../src/catalogue/ports.ts";
import type { FetchInput, FetchedListing } from "../src/discovery/ports.ts";
import type { Logger } from "../src/shared/logger.ts";
import { createHttp } from "../src/adapters/sources/http.ts";
import { createWebPageFetcher } from "../src/adapters/sources/web-page.ts";
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
