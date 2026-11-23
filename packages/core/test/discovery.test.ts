import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { events, listing, rawListing, run, source } from "@magic-events/db";
import { asc, eq, sql } from "drizzle-orm";
import { createDomainEvents } from "../src/adapters/events/node-events.ts";
import { createDiscoveryRepository } from "../src/adapters/storage/discovery-repository.ts";
import { createTransactionalDb } from "../src/adapters/storage/transactions.ts";
import type {
  ClaimedRawListing,
  Discovery,
  FetchedListing,
  FetchResult,
  SaveSourceInput,
  SourceFetcher,
} from "../src/discovery/ports.ts";
import { errorMessage } from "../src/discovery/fetching.ts";
import { DiscoveryService } from "../src/discovery/service.ts";
import { AppError } from "../src/shared/errors.ts";
import type { DomainEvent, DomainEventPublisher } from "../src/shared/domain-events.ts";
import type { Logger } from "../src/shared/logger.ts";
import type { Transactions } from "../src/shared/transactions.ts";
import { createHarness, testSettings, type Harness } from "../src/testing/harness.ts";
import { fixture } from "./fixtures/sources/server.ts";

// Discovery against the database: sources, runs, listings and raw listings, the hand-off to Data processing,
// and the domain events. The adapters are fakes and the clock is the test's.

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

// What each fake adapter returns next.
const next: Record<string, () => Promise<FetchResult>> = {};
function fakeFetcher(kind: string): SourceFetcher {
  return {
    kind,
    fetch: () => (next[kind] ?? (() => Promise.resolve({ listings: [], complete: true, syncState: {} })))(),
  };
}
function returns(kind: string, listings: FetchedListing[], complete = true, syncState: Record<string, unknown> = {}) {
  next[kind] = () => Promise.resolve({ listings, complete, syncState });
}
function page(id: string, content: string): FetchedListing {
  return { sourceListingId: id, url: `https://example.com/${id}`, contentType: "text/html", content };
}

let now = new Date("2026-11-23T08:00:00Z");
const clock = () => now;
function later(hours: number) {
  now = new Date(now.getTime() + hours * 60 * 60 * 1000);
}

let harness: Harness;
// Discovery wired with the Transactions it shares its database handle with, as Data processing uses it.
let discovery: Discovery;
let transactions: Transactions;
// Every domain event delivered to a subscriber, through the harness's services and the Discovery wired here.
const delivered: DomainEvent[] = [];

const pages: SaveSourceInput = { name: "Organiser pages", kind: "web_page", locationSlug: "hermanus", priority: 10 };

before(async () => {
  const fetchers = [fakeFetcher("web_page"), fakeFetcher("rss_feed")];
  const domainEvents = createDomainEvents(silent);
  domainEvents.subscribe("*", (event) => {
    delivered.push(event);
  });
  harness = await createHarness({ fetchers, clock, domainEvents });
  const wired = createTransactionalDb(harness.db);
  transactions = wired.transactions;
  // Held back until the transaction commits, as app.ts wires it.
  const events: DomainEventPublisher = {
    publish(event) {
      wired.afterCommit(() => {
        domainEvents.publish(event);
      });
    },
  };
  const url = process.env.TEST_DATABASE_URL ?? "";
  discovery = new DiscoveryService({
    repository: createDiscoveryRepository(wired.db),
    events,
    catalogue: harness.services.catalogue,
    fetchers,
    settings: testSettings(url).discovery,
    logger: silent,
    clock,
  });
});

after(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql`truncate table ${events}, ${rawListing}, ${listing}, ${run}, ${source} cascade`);
  for (const kind of Object.keys(next)) Reflect.deleteProperty(next, kind);
  delivered.length = 0;
  now = new Date("2026-11-23T08:00:00Z");
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

async function eventsOf(type: string) {
  return harness.db.select().from(events).where(eq(events.type, type)).orderBy(asc(events.recordedAt));
}

async function rawListingsOf(sourceListingId: string) {
  return harness.db
    .select({ raw: rawListing })
    .from(rawListing)
    .innerJoin(listing, eq(listing.id, rawListing.listingId))
    .where(eq(listing.sourceListingId, sourceListingId))
    .orderBy(asc(rawListing.fetchedAt))
    .then((rows) => rows.map((row) => row.raw));
}

// Claims in a transaction and does the work with the claim before it ends, as a processing worker does.
function claimed<T>(work: (claim: ClaimedRawListing | null) => Promise<T>): Promise<T> {
  return transactions.run(async () => work(await discovery.claimPendingRawListing()));
}

describe("Discovery repository: saving a source", () => {
  const quicket: SaveSourceInput = {
    name: "Quicket",
    kind: "quicket",
    locationSlug: "hermanus",
    credentialsSetting: "QUICKET_API_KEY",
  };

  test("creates the source with the defaults from the settings", async () => {
    const saved = await harness.services.discovery.saveSource(quicket);
    const [row] = await harness.db.select().from(source).where(eq(source.id, saved.id));

    assert.ok(row);
    assert.equal(row.kind, "quicket");
    assert.equal(row.credentialsSetting, "QUICKET_API_KEY");
    assert.deepEqual(row.syncState, {});
    assert.ok(row.fetchIntervalHours > 0);
    assert.ok(row.missedRunsBeforeRemoval > 0);
    assert.ok(row.maxProcessingAttempts > 0);
  });

  test("updates the source with the same name in the same location, and keeps its sync state", async () => {
    const first = await harness.services.discovery.saveSource(quicket);
    // The adapter's sync state, as a run would have left it.
    await harness.db
      .update(source)
      .set({ syncState: { lastModified: "2026-11-20T08:00:00Z" } })
      .where(eq(source.id, first.id));

    const second = await harness.services.discovery.saveSource({ ...quicket, priority: 30, fetchIntervalHours: 6 });

    assert.equal(second.id, first.id);
    assert.equal(second.priority, 30);
    assert.equal(second.fetchIntervalHours, 6);
    const rows = await harness.db.select().from(source);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.syncState, { lastModified: "2026-11-20T08:00:00Z" });
  });

  test("keeps a source of the same name in another location apart", async () => {
    await harness.services.catalogue.saveLocation({
      name: "Stanford",
      slug: "stanford",
      country: "South Africa",
      region: "Western Cape",
      timezone: "Africa/Johannesburg",
      latitude: -34.4416,
      longitude: 19.4589,
    });
    await harness.services.discovery.saveSource(quicket);
    await harness.services.discovery.saveSource({ ...quicket, locationSlug: "stanford" });
    assert.equal(await harness.db.$count(source), 2);
  });

  test("refuses a location Catalogue does not have", async () => {
    await assert.rejects(
      harness.services.discovery.saveSource({ ...quicket, locationSlug: "atlantis" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal(await harness.db.$count(source), 0);
  });
});

describe("Discovery: a run against the database", () => {
  test("saves new listings as pending raw listings with their domain events, and closes the run", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    returns("web_page", [page("a", "<p>A</p>"), page("b", "<p>B</p>")], true, { cursor: "x" });

    const summary = await harness.services.discovery.runSource(saved.id);

    assert.equal(summary.status, "succeeded");
    const [runRow] = await harness.db.select().from(run).where(eq(run.id, summary.runId));
    assert.ok(runRow);
    assert.equal(runRow.status, "succeeded");
    assert.equal(runRow.complete, true);
    assert.deepEqual([runRow.listingsFound, runRow.listingsNewOrChanged, runRow.listingsUnchanged], [2, 2, 0]);
    assert.equal(runRow.startedAt.toISOString(), "2026-11-23T08:00:00.000Z");
    assert.ok(runRow.finishedAt);
    assert.equal(runRow.error, null);

    const listings = await harness.db.select().from(listing).orderBy(asc(listing.sourceListingId));
    assert.deepEqual(
      listings.map((one) => [one.sourceListingId, one.url, one.state, one.firstSeenRunId, one.lastSeenRunId]),
      [
        ["a", "https://example.com/a", "listed", summary.runId, summary.runId],
        ["b", "https://example.com/b", "listed", summary.runId, summary.runId],
      ],
    );

    const [a] = await rawListingsOf("a");
    assert.ok(a);
    assert.equal(a.status, "pending");
    assert.equal(a.kind, "listing");
    assert.equal(a.content, "<p>A</p>");
    assert.equal(a.contentType, "text/html");
    assert.equal(a.fingerprint, listings[0]?.fingerprint);
    assert.equal(a.runId, summary.runId);

    const captured = await eventsOf("raw_listing.captured");
    assert.equal(captured.length, 2);
    const forA = captured.find((event) => event.resourceId === a.id);
    assert.deepEqual(forA?.data, { listing_id: a.listingId, run_id: summary.runId, kind: "listing" });

    const [sourceRow] = await harness.db.select().from(source).where(eq(source.id, saved.id));
    assert.deepEqual(sourceRow?.syncState, { cursor: "x" });
  });

  test("a changed listing gets a new raw listing; an unchanged one is only seen", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    returns("web_page", [page("a", "A"), page("b", "B")]);
    await harness.services.discovery.runSource(saved.id);
    later(24);
    returns("web_page", [page("a", "A"), page("b", "B, moved to Sunday")]);

    const second = await harness.services.discovery.runSource(saved.id);

    assert.deepEqual([second.listingsNewOrChanged, second.listingsUnchanged], [1, 1]);
    assert.equal((await rawListingsOf("a")).length, 1);
    const b = await rawListingsOf("b");
    assert.deepEqual(
      b.map((raw) => raw.content),
      ["B", "B, moved to Sunday"],
    );
    const rows = await harness.db.select().from(listing).orderBy(asc(listing.sourceListingId));
    assert.ok(rows.every((one) => one.lastSeenRunId === second.runId));
    assert.equal(rows[1]?.fingerprint, b[1]?.fingerprint);
    assert.notEqual(rows[1]?.firstSeenRunId, second.runId);
  });

  test("a failed fetch is a failed run in the database", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    next.web_page = () => Promise.reject(new Error("GET https://example.com answered 503 Service Unavailable"));

    const summary = await harness.services.discovery.runSource(saved.id);

    const [runRow] = await harness.db.select().from(run).where(eq(run.id, summary.runId));
    assert.equal(runRow?.status, "failed");
    assert.equal(runRow.error, "GET https://example.com answered 503 Service Unavailable");
    assert.ok(runRow.finishedAt);
  });

  test("a page with NUL bytes is saved without them, and is unchanged when fetched again", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    // A Webtickets event page, cut down. Its description ends in a NUL byte.
    const html = fixture("webtickets-nul.html").toString("utf8");
    assert.ok(html.includes("\u0000"));
    returns("web_page", [page("webtickets", html)]);

    const first = await harness.services.discovery.runSource(saved.id);
    later(24);
    const second = await harness.services.discovery.runSource(saved.id);

    assert.equal(first.status, "succeeded");
    const [raw] = await rawListingsOf("webtickets");
    assert.equal(raw?.content, html.replaceAll("\u0000", ""));
    assert.equal(second.listingsUnchanged, 1);
  });

  test("the error of a query the database refuses is its short reason, not the query", async () => {
    const repository = createDiscoveryRepository(harness.db);
    const saved = await harness.services.discovery.saveSource(pages);
    const runId = await repository.startRun(saved.id, now);
    const content = `<p>${"page ".repeat(1000)}\u0000</p>`;

    const version = { runId, url: null, contentType: "text/html", content, fingerprint: "f", fetchedAt: now };
    const caught: unknown = await repository.saveNewListing({ sourceId: saved.id, sourceListingId: "a", ...version }).then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^Failed query:/);
    const message = errorMessage(caught);
    assert.match(message, /^The database refused a query: invalid byte sequence for encoding "UTF8": 0x00/);
    assert.doesNotMatch(message, /page|insert/);
  });

  test("a source of a kind with no adapter is a failed run, not an error", async () => {
    const saved = await harness.services.discovery.saveSource({ ...pages, name: "Quicket", kind: "quicket" });
    const summary = await harness.services.discovery.runSource(saved.id);
    assert.equal(summary.status, "failed");
    assert.match(summary.error ?? "", /quicket/);
  });

  test("an unknown source is not_found", async () => {
    await assert.rejects(
      harness.services.discovery.runSource("00000000-0000-4000-8000-00000000abcd"),
      (error) => error instanceof AppError && error.code === "not_found",
    );
  });
});

describe("Discovery: listings that disappear", () => {
  test("removes a listing after the missed runs, with a pending raw listing of kind removed", async () => {
    const saved = await harness.services.discovery.saveSource({ ...pages, missedRunsBeforeRemoval: 2 });
    returns("web_page", [page("a", "A"), page("b", "B")]);
    await harness.services.discovery.runSource(saved.id);
    returns("web_page", [page("a", "A")]);
    later(24);
    assert.equal((await harness.services.discovery.runSource(saved.id)).listingsRemoved, 0);
    later(24);
    const removing = await harness.services.discovery.runSource(saved.id);

    assert.equal(removing.listingsRemoved, 1);
    const [b] = await harness.db.select().from(listing).where(eq(listing.sourceListingId, "b"));
    assert.equal(b?.state, "removed");
    const versions = await rawListingsOf("b");
    const removed = versions.at(-1);
    assert.ok(removed);
    assert.equal(removed.kind, "removed");
    assert.equal(removed.status, "pending");
    assert.equal(removed.content, null);
    assert.equal(removed.runId, removing.runId);
    const event = (await eventsOf("raw_listing.captured")).find((one) => one.resourceId === removed.id);
    assert.deepEqual(event?.data, { listing_id: b.id, run_id: removing.runId, kind: "removed" });
  });

  test("an incomplete run never counts as a miss", async () => {
    const saved = await harness.services.discovery.saveSource({
      ...pages,
      name: "Hermanus Times",
      kind: "rss_feed",
      missedRunsBeforeRemoval: 1,
    });
    returns("rss_feed", [page("post-1", "Post")], false);
    await harness.services.discovery.runSource(saved.id);
    returns("rss_feed", [], false);
    for (let day = 0; day < 3; day += 1) {
      later(24);
      await harness.services.discovery.runSource(saved.id);
    }
    const [post] = await harness.db.select().from(listing);
    assert.equal(post?.state, "listed");
  });

  test("a failed run never counts as a miss", async () => {
    const saved = await harness.services.discovery.saveSource({ ...pages, missedRunsBeforeRemoval: 1 });
    returns("web_page", [page("a", "A")]);
    await harness.services.discovery.runSource(saved.id);
    next.web_page = () => Promise.reject(new Error("timed out"));
    later(24);
    await harness.services.discovery.runSource(saved.id);
    const [a] = await harness.db.select().from(listing);
    assert.equal(a?.state, "listed");
  });

  test("a listing that comes back is listed again with a new raw listing", async () => {
    const saved = await harness.services.discovery.saveSource({ ...pages, missedRunsBeforeRemoval: 1 });
    returns("web_page", [page("a", "A")]);
    await harness.services.discovery.runSource(saved.id);
    returns("web_page", []);
    later(24);
    await harness.services.discovery.runSource(saved.id);
    returns("web_page", [page("a", "A")]);
    later(24);
    const back = await harness.services.discovery.runSource(saved.id);

    assert.equal(back.listingsNewOrChanged, 1);
    const [a] = await harness.db.select().from(listing);
    assert.equal(a?.state, "listed");
    assert.equal(a.lastSeenRunId, back.runId);
    assert.deepEqual(
      (await rawListingsOf("a")).map((raw) => raw.kind),
      ["listing", "removed", "listing"],
    );
  });
});

describe("Discovery: sources that are due", () => {
  test("finds the active sources whose interval has passed or that never ran, not one being fetched", async () => {
    const services = harness.services.discovery;
    const daily = await services.saveSource({ ...pages, name: "Daily", fetchIntervalHours: 24 });
    const weekly = await services.saveSource({ ...pages, name: "Weekly", fetchIntervalHours: 168 });
    const failing = await services.saveSource({ ...pages, name: "Failing", fetchIntervalHours: 24 });
    await services.saveSource({ ...pages, name: "Never ran" });
    await services.saveSource({ ...pages, name: "Inactive", active: false });
    const busy = await services.saveSource({ ...pages, name: "Busy", fetchIntervalHours: 1 });
    await services.runSource(daily.id);
    await services.runSource(weekly.id);
    next.web_page = () => Promise.reject(new Error("GET https://example.com answered 503 Service Unavailable"));
    await services.runSource(failing.id);

    later(23);
    // Started 30 minutes ago: in progress, not stale.
    await harness.db.insert(run).values({ sourceId: busy.id, startedAt: new Date(now.getTime() - 30 * 60 * 1000) });
    assert.deepEqual(
      (await services.findDueSources()).map((one) => one.name),
      ["Never ran"],
    );

    later(1);
    assert.deepEqual(
      (await services.findDueSources()).map((one) => one.name),
      // Busy's run is now 90 minutes old, past the run timeout, so it was closed.
      ["Busy", "Daily", "Failing", "Never ran"],
    );
  });

  test("closes a run that did not finish as failed, so its source is due again", async () => {
    const services = harness.services.discovery;
    const crashed = await services.saveSource({ ...pages, name: "Crashed", fetchIntervalHours: 1 });
    const other = await services.saveSource({ ...pages, name: "Other", fetchIntervalHours: 1 });
    const [left] = await harness.db
      .insert(run)
      .values([
        { sourceId: crashed.id, startedAt: now },
        { sourceId: other.id, startedAt: now },
      ])
      .returning();
    assert.ok(left);

    // The default run timeout is 60 minutes.
    later(1);
    assert.deepEqual(await services.findDueSources(), []);
    later(0.1);
    assert.deepEqual(
      (await services.findDueSources()).map((one) => one.name),
      ["Crashed", "Other"],
    );
    const rows = await harness.db.select().from(run);
    assert.ok(rows.every((one) => one.status === "failed" && one.error === "The run did not finish."));
    assert.ok(rows.every((one) => one.finishedAt?.getTime() === now.getTime()));
  });

  test("runSource on a source being fetched starts no second run and leaves the first alone", async () => {
    const services = harness.services.discovery;
    const saved = await services.saveSource(pages);
    const [inProgress] = await harness.db.insert(run).values({ sourceId: saved.id, startedAt: now }).returning();
    assert.ok(inProgress);

    later(0.5);
    const summary = await services.runSource(saved.id);

    assert.equal(summary.status, "failed");
    assert.equal(summary.runId, inProgress.id);
    assert.equal(summary.error, "The source is already being fetched.");
    const rows = await harness.db.select().from(run);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "running");

    // Past the run timeout, the next runSource closes it and fetches.
    later(1);
    returns("web_page", [page("a", "A")]);
    assert.equal((await services.runSource(saved.id)).status, "succeeded");
    const [closed] = await harness.db.select().from(run).where(eq(run.id, inProgress.id));
    assert.equal(closed?.status, "failed");
    assert.equal(closed.error, "The run did not finish.");
  });

  test("lists every source", async () => {
    await harness.services.discovery.saveSource({ ...pages, name: "B" });
    await harness.services.discovery.saveSource({ ...pages, name: "A" });
    assert.deepEqual(
      (await harness.services.discovery.listSources()).map((one) => one.name),
      ["A", "B"],
    );
  });
});

describe("Discovery: the hand-off to Data processing", () => {
  test("claims the latest version of a listing, with its source, and supersedes the older one", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    returns("web_page", [page("a", "first")]);
    await harness.services.discovery.runSource(saved.id);
    later(24);
    returns("web_page", [page("a", "second")]);
    await harness.services.discovery.runSource(saved.id);
    const [older, newer] = await rawListingsOf("a");
    assert.ok(older && newer);

    const claim = await claimed((one) => Promise.resolve(one));

    assert.ok(claim);
    assert.equal(claim.id, newer.id);
    assert.equal(claim.content, "second");
    assert.equal(claim.kind, "listing");
    assert.equal(claim.url, "https://example.com/a");
    assert.equal(claim.contentType, "text/html");
    assert.equal(claim.fetchedAt, newer.fetchedAt.toISOString());
    assert.equal(claim.attempts, 0);
    const location = await harness.services.catalogue.getLocation({ slug: "hermanus" });
    assert.deepEqual(claim.source, {
      id: saved.id,
      name: "Organiser pages",
      kind: "web_page",
      priority: 10,
      locationId: location?.id,
    });

    const [olderNow] = await harness.db.select().from(rawListing).where(eq(rawListing.id, older.id));
    assert.equal(olderNow?.status, "superseded");
    const superseded = await eventsOf("raw_listing.superseded");
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0]?.resourceId, older.id);
    assert.deepEqual(superseded[0].data, { listing_id: older.listingId, raw_listing_id: newer.id });

    // Nothing else is pending: the claim was not marked, so the latest is pending again, and the older is not.
    const again = await claimed((one) => Promise.resolve(one));
    assert.equal(again?.id, newer.id);
  });

  test("returns null when nothing is pending", async () => {
    assert.equal(await claimed((one) => Promise.resolve(one)), null);
  });

  test("two transactions at once never claim the same raw listing", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    returns("web_page", [page("a", "A"), page("b", "B")]);
    await harness.services.discovery.runSource(saved.id);

    // Each holds its claim until both have claimed.
    let release: () => void = () => {};
    const bothClaimed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const worker = () =>
      claimed(async (claim) => {
        count += 1;
        if (count === 2) release();
        await bothClaimed;
        return claim?.id ?? null;
      });

    const [first, second] = await Promise.all([worker(), worker()]);
    assert.ok(first && second);
    assert.notEqual(first, second);

    // With one pending and two workers, one gets it and the other gets nothing.
    count = 0;
    const single = await Promise.all([
      claimed(async (claim) => {
        await discovery.markRawListingProcessed(claim?.id ?? "");
        return claim?.id ?? null;
      }),
    ]);
    assert.ok(single[0]);
    let releaseOne: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });
    const holder = claimed(async (claim) => {
      await held;
      return claim?.id ?? null;
    });
    // Give the holder time to lock the one left.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const other = await claimed((claim) => Promise.resolve(claim?.id ?? null));
    releaseOne();
    assert.ok(await holder);
    assert.equal(other, null);
  });

  test("marks a raw listing processed, with its domain event", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    returns("web_page", [page("a", "A")]);
    await harness.services.discovery.runSource(saved.id);

    const id = await claimed(async (claim) => {
      assert.ok(claim);
      await discovery.markRawListingProcessed(claim.id);
      return claim.id;
    });

    const [row] = await harness.db.select().from(rawListing).where(eq(rawListing.id, id));
    assert.equal(row?.status, "processed");
    const processed = await eventsOf("raw_listing.processed");
    assert.deepEqual(
      processed.map((event) => [event.resourceId, event.data]),
      [[id, { listing_id: row.listingId }]],
    );
    assert.equal(await claimed((one) => Promise.resolve(one)), null);
    // Only a pending raw listing can be marked.
    await assert.rejects(discovery.markRawListingProcessed(id), /only a pending one can be marked/);
  });

  test("marks a raw listing failed, back to pending until the source's max attempts, then failed", async () => {
    const saved = await harness.services.discovery.saveSource({ ...pages, maxProcessingAttempts: 2 });
    returns("web_page", [page("a", "A")]);
    await harness.services.discovery.runSource(saved.id);

    const first = await claimed(async (claim) => {
      assert.ok(claim);
      return { id: claim.id, outcome: await discovery.markRawListingFailed(claim.id, "wrong shape") };
    });
    assert.deepEqual(first.outcome, { attempts: 1, willRetry: true });
    const [pending] = await harness.db.select().from(rawListing).where(eq(rawListing.id, first.id));
    assert.deepEqual([pending?.status, pending?.attempts, pending?.error], ["pending", 1, "wrong shape"]);

    const second = await claimed(async (claim) => {
      assert.ok(claim);
      assert.equal(claim.attempts, 1);
      return discovery.markRawListingFailed(claim.id, "timed out");
    });
    assert.deepEqual(second, { attempts: 2, willRetry: false });
    const [failed] = await harness.db.select().from(rawListing).where(eq(rawListing.id, first.id));
    assert.ok(failed);
    assert.deepEqual([failed.status, failed.attempts, failed.error], ["failed", 2, "timed out"]);
    assert.equal(await claimed((one) => Promise.resolve(one)), null);

    const failedEvents = await eventsOf("raw_listing.failed");
    assert.deepEqual(
      failedEvents.map((event) => event.data),
      [
        { listing_id: failed.listingId, error: "wrong shape", attempt: 1, will_retry: true },
        { listing_id: failed.listingId, error: "timed out", attempt: 2, will_retry: false },
      ],
    );
  });

  test("a newer version supersedes an older one that failed for good", async () => {
    const saved = await harness.services.discovery.saveSource({ ...pages, maxProcessingAttempts: 1 });
    returns("web_page", [page("a", "first")]);
    await harness.services.discovery.runSource(saved.id);
    await claimed(async (claim) => {
      assert.ok(claim);
      await discovery.markRawListingFailed(claim.id, "wrong shape");
    });
    later(24);
    returns("web_page", [page("a", "second")]);
    await harness.services.discovery.runSource(saved.id);

    const claim = await claimed((one) => Promise.resolve(one));

    assert.equal(claim?.content, "second");
    const [older] = await rawListingsOf("a");
    assert.equal(older?.status, "superseded");
  });

  test("hands over a removed listing's raw listing with no content", async () => {
    const saved = await harness.services.discovery.saveSource({ ...pages, missedRunsBeforeRemoval: 1 });
    returns("web_page", [page("a", "A")]);
    await harness.services.discovery.runSource(saved.id);
    await claimed(async (claim) => {
      assert.ok(claim);
      await discovery.markRawListingProcessed(claim.id);
    });
    returns("web_page", []);
    later(24);
    await harness.services.discovery.runSource(saved.id);

    const claim = await claimed((one) => Promise.resolve(one));

    assert.equal(claim?.kind, "removed");
    assert.equal(claim.content, null);
    assert.equal(claim.contentType, null);
  });

  test("gives the priority of each listing's source", async () => {
    const high = await harness.services.discovery.saveSource({ ...pages, name: "High", priority: 20 });
    const low = await harness.services.discovery.saveSource({ ...pages, name: "Low", priority: 10 });
    returns("web_page", [page("h", "H")]);
    await harness.services.discovery.runSource(high.id);
    returns("web_page", [page("l", "L")]);
    await harness.services.discovery.runSource(low.id);
    const rows = await harness.db.select().from(listing);
    const id = (sourceListingId: string) => rows.find((one) => one.sourceListingId === sourceListingId)?.id ?? "";

    const priorities = await harness.services.discovery.getListingPriorities([id("h"), id("l")]);

    assert.deepEqual(priorities, { [id("h")]: 20, [id("l")]: 10 });
    assert.deepEqual(await harness.services.discovery.getListingPriorities([]), {});
  });
});

describe("Discovery: domain events are published", () => {
  test("a run publishes one raw_listing.captured per new raw listing, exactly as appended to the log", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    returns("web_page", [page("a", "A"), page("b", "B")]);

    const summary = await harness.services.discovery.runSource(saved.id);

    const logged = await eventsOf("raw_listing.captured");
    assert.equal(logged.length, 2);
    assert.deepEqual(
      delivered.map((event) => event.type),
      ["raw_listing.captured", "raw_listing.captured"],
    );
    for (const row of logged) {
      const matching = delivered.filter((event) => event.id === row.id);
      assert.equal(matching.length, 1);
      assert.deepEqual(matching[0], {
        id: row.id,
        type: "raw_listing.captured",
        resourceId: row.resourceId,
        data: row.data,
        recordedAt: row.recordedAt.toISOString(),
      });
      assert.equal(row.data.run_id, summary.runId);
    }
  });

  test("an event published inside a transaction that rolls back is never delivered", async () => {
    const saved = await harness.services.discovery.saveSource(pages);
    returns("web_page", [page("a", "first")]);
    await harness.services.discovery.runSource(saved.id);
    later(24);
    returns("web_page", [page("a", "second")]);
    await harness.services.discovery.runSource(saved.id);
    delivered.length = 0;

    await assert.rejects(
      claimed((claim) => {
        assert.ok(claim);
        return Promise.reject(new Error("The worker crashed"));
      }),
      /The worker crashed/,
    );

    assert.equal(delivered.length, 0);
    assert.equal((await eventsOf("raw_listing.superseded")).length, 0);

    // Claimed again and committed, the superseded event is delivered once.
    await claimed((claim) => Promise.resolve(claim));
    assert.deepEqual(
      delivered.map((event) => event.type),
      ["raw_listing.superseded"],
    );
  });
});
