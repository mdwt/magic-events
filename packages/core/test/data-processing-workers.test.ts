import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { events, experience, rawListing } from "@magic-events/db";
import { eq } from "drizzle-orm";
import { createDataProcessingRepository } from "../src/adapters/storage/data-processing-repository.ts";
import { createDiscoveryRepository } from "../src/adapters/storage/discovery-repository.ts";
import { createTransactionalDb } from "../src/adapters/storage/transactions.ts";
import type { ProcessingOutcome } from "../src/data-processing/ports.ts";
import { DataProcessingService } from "../src/data-processing/service.ts";
import type { SourceFetcher } from "../src/discovery/ports.ts";
import { DiscoveryService } from "../src/discovery/service.ts";
import type { DomainEvent, DomainEventPublisher } from "../src/shared/domain-events.ts";
import { LanguageModelFailed } from "../src/shared/language-model.ts";
import type { Logger } from "../src/shared/logger.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";
import { createHarness, type Harness, testSettings } from "../src/testing/harness.ts";

// Processing workers on more than one server instance, against the database: a raw listing that fails is never
// claimed by another worker before its failed attempt is recorded.

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };
const PAGE_URL = "https://fynarts.example.com/";

const fetcher: SourceFetcher = {
  kind: "web_page",
  fetch: () =>
    Promise.resolve({
      listings: [{ sourceListingId: PAGE_URL, url: PAGE_URL, contentType: "text/html", content: "<h1>FynArts</h1>" }],
      complete: true,
      syncState: {},
    }),
};

// Every extraction fails, so every attempt at the raw listing fails.
const model = fakeLanguageModel({ extract: () => new LanguageModelFailed("wrong_shape") });

let harness: Harness;
// The domain events the first instance delivered, once their transaction committed.
const delivered: DomainEvent[] = [];
// Runs between the first instance's failure and the mark that records it.
let onFail: () => Promise<void> = () => Promise.resolve();

// The first worker's server instance, with its own transactions handle as another process has. Its Discovery is the
// real one, with a pause before a raw listing is marked failed, so the test can send another worker in at that moment.
function firstInstance(): DataProcessingService {
  const storage = createTransactionalDb(harness.db);
  const settings = testSettings(process.env.TEST_DATABASE_URL ?? "");
  const events: DomainEventPublisher = {
    publish(event) {
      storage.afterCommit(() => {
        delivered.push(event);
      });
    },
  };
  // Catalogue is only read before the failure, so the harness's serves.
  const catalogue = harness.services.catalogue;
  const discovery = new DiscoveryService({
    repository: createDiscoveryRepository(storage.db),
    events,
    catalogue,
    fetchers: [],
    settings: settings.discovery,
    logger: silent,
  });
  const markRawListingFailed = discovery.markRawListingFailed.bind(discovery);
  discovery.markRawListingFailed = async (rawListingId, error) => {
    await onFail();
    return markRawListingFailed(rawListingId, error);
  };
  return new DataProcessingService({
    repository: createDataProcessingRepository(storage.db),
    catalogue,
    discovery,
    languageModel: model,
    transactions: storage.transactions,
    settings: settings.processing,
    logger: silent,
  });
}

before(async () => {
  harness = await createHarness({ languageModel: model, fetchers: [fetcher] });
  await harness.services.catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "South Africa",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
  const source = await harness.services.discovery.saveSource({
    name: "FynArts site",
    kind: "web_page",
    locationSlug: "hermanus",
    settings: { urls: [PAGE_URL] },
    maxProcessingAttempts: 3,
  });
  await harness.services.discovery.runSource(source.id);
});

after(async () => {
  await harness.close();
});

describe("Two processing workers on a raw listing that fails", () => {
  // A time limit, so a wait on another test's truncate of the shared database fails rather than hangs.
  test("the other worker cannot claim it until the failed attempt is recorded, and the attempt counts once", { timeout: 30_000 }, async () => {
    // The second worker is the harness's own instance, which tries to claim at the worst moment.
    let second: ProcessingOutcome | null | undefined;
    onFail = async () => {
      onFail = () => Promise.resolve();
      second = await harness.services.dataProcessing.processNext();
    };

    const first = await firstInstance().processNext();
    assert.ok(first);
    assert.equal(first.outcome, "failed");
    assert.match(first.error ?? "", /wrong_shape/);
    assert.equal(second, null, "the second worker claimed the raw listing before its failure was recorded");
    assert.equal(model.of("extract").length, 1);

    const [stored] = await harness.db.select({ status: rawListing.status, attempts: rawListing.attempts }).from(rawListing);
    assert.deepEqual(stored, { status: "pending", attempts: 1 });
    assert.equal((await harness.db.select().from(experience)).length, 0);
    assert.equal((await harness.db.select().from(events).where(eq(events.type, "raw_listing.failed"))).length, 1);
    assert.deepEqual(
      delivered.filter((event) => event.type === "raw_listing.failed").map((event) => event.data),
      [{ listing_id: first.listingId, error: first.error, attempt: 1, will_retry: true }],
    );

    // It is retried, and each later attempt counts one more, up to the source's max.
    const rest = await harness.services.dataProcessing.processPending();
    assert.deepEqual(
      rest.map((outcome) => outcome.outcome),
      ["failed", "failed"],
    );
    const [last] = await harness.db.select({ status: rawListing.status, attempts: rawListing.attempts }).from(rawListing);
    assert.deepEqual(last, { status: "failed", attempts: 3 });
  });
});
