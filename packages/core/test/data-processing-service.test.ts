import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Catalogue, Location, StoredExperience } from "../src/catalogue/ports.ts";
import type {
  AttributeDefinition,
  DataProcessingRepository,
  SaveSeasonInput,
  Season,
} from "../src/data-processing/ports.ts";
import { DataProcessingService } from "../src/data-processing/service.ts";
import { AppError } from "../src/shared/errors.ts";
import type { Discovery, ListingSelection, Source } from "../src/discovery/ports.ts";
import type { Logger } from "../src/shared/logger.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

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

const notUsed = () => Promise.reject(new Error("not used"));

const catalogue: Catalogue = {
  searchExperiences: notUsed,
  saveLocation: notUsed,
  getLocation: (by) => Promise.resolve(("slug" in by ? by.slug : by.id) === "hermanus" ? hermanus : null),
  getExperience: notUsed,
  findExperiencesByListing: notUsed,
  findMatchCandidates: notUsed,
  saveExperience: notUsed,
  removeSourceLink: notUsed,
  recordMissedReading: notUsed,
  getChangesSince: notUsed,
  keepUp: notUsed,
  embedExperiences: notUsed,
};

const discovery: Discovery = {
  saveSource: notUsed,
  listSources: notUsed,
  findDueSources: notUsed,
  runSource: notUsed,
  runLocation: notUsed,
  getListing: notUsed,
  requeueListings: notUsed,
  claimPendingRawListing: notUsed,
  markRawListingProcessed: notUsed,
  markRawListingFailed: notUsed,
  getListingPriorities: notUsed,
};

function setup() {
  const attributes: AttributeDefinition[] = [];
  const seasons: Omit<Season, "id">[] = [];
  const repository: DataProcessingRepository = {
    upsertAttribute(input) {
      attributes.push(input);
      return Promise.resolve(input);
    },
    upsertTag: (input) => Promise.resolve(input),
    upsertSeason(input) {
      seasons.push(input);
      return Promise.resolve({ id: "00000000-0000-4000-8000-000000000003", ...input });
    },
    listDefinitions: notUsed,
    listTagSlugs: notUsed,
    listSeasons: notUsed,
    appendWarehouseRows: notUsed,
    saveUndefinedValues: notUsed,
  };
  const service = new DataProcessingService({
    repository,
    catalogue,
    discovery,
    languageModel: fakeLanguageModel(),
    transactions: { run: (work) => work() },
    settings: { horizonMonths: 24, workers: 1 },
    logger: silent,
  });
  return { service, attributes, seasons };
}

const scale: AttributeDefinition = {
  key: "scale",
  name: "Scale",
  description: "How far people travel for it",
  type: "option",
  defaultValue: "local",
  multiple: false,
  filterable: true,
  options: [
    { key: "local", name: "Local", description: "Draws the town" },
    { key: "regional", name: "Regional", description: "Draws the province" },
    { key: "major", name: "Major", description: "Draws the country" },
  ],
};

const minimumAge: AttributeDefinition = {
  key: "minimum_age",
  name: "Minimum age",
  description: "The age limit a source states",
  type: "number",
  defaultValue: null,
  multiple: false,
  filterable: true,
  options: [],
};

function invalidAt(path: string) {
  return (error: unknown) =>
    error instanceof AppError && error.code === "invalid_input" && (error.details ?? []).some((d) => d.path === path);
}

describe("DataProcessingService.saveAttribute", () => {
  test("saves a valid option attribute with a default that is one of its options", async () => {
    const { service, attributes } = setup();
    const saved = await service.saveAttribute(scale);
    assert.deepEqual(saved, scale);
    assert.equal(attributes.length, 1);
  });

  test("saves attributes of every other type with a default that fits", async () => {
    const { service } = setup();
    await service.saveAttribute({ ...minimumAge, defaultValue: 18 });
    await service.saveAttribute({ ...minimumAge, key: "accessible", type: "boolean", defaultValue: false });
    await service.saveAttribute({ ...minimumAge, key: "note", type: "text", defaultValue: "none" });
    await service.saveAttribute({ ...minimumAge, key: "opens", type: "date", defaultValue: "2027-06-01" });
  });

  test("refuses options on an attribute that is not an option attribute", async () => {
    const { service, attributes } = setup();
    await assert.rejects(service.saveAttribute({ ...minimumAge, options: scale.options }), invalidAt("options"));
    assert.equal(attributes.length, 0);
  });

  test("refuses two options with the same key", async () => {
    const { service } = setup();
    const options = [...scale.options, { key: "local", name: "Local again", description: "A duplicate" }];
    await assert.rejects(service.saveAttribute({ ...scale, options }), invalidAt("options.3.key"));
  });

  test("refuses an option attribute's default that is not one of its options", async () => {
    const { service } = setup();
    await assert.rejects(service.saveAttribute({ ...scale, defaultValue: "global" }), invalidAt("defaultValue"));
    await assert.rejects(service.saveAttribute({ ...scale, defaultValue: 3 }), invalidAt("defaultValue"));
  });

  test("refuses a default that does not fit the type", async () => {
    const { service } = setup();
    await assert.rejects(service.saveAttribute({ ...minimumAge, defaultValue: "18" }), invalidAt("defaultValue"));
    await assert.rejects(
      service.saveAttribute({ ...minimumAge, type: "boolean", defaultValue: "yes" }),
      invalidAt("defaultValue"),
    );
    await assert.rejects(
      service.saveAttribute({ ...minimumAge, type: "text", defaultValue: 1 }),
      invalidAt("defaultValue"),
    );
    await assert.rejects(
      service.saveAttribute({ ...minimumAge, type: "date", defaultValue: "2027-02-30" }),
      invalidAt("defaultValue"),
    );
  });
});

describe("DataProcessingService.saveSeason", () => {
  const whaleSeason: SaveSeasonInput = {
    locationSlug: "hermanus",
    slug: "whale-season",
    name: "Whale season",
    description: "Southern right whales in Walker Bay",
    periods: [{ startDate: "2027-06-01", endDate: "2027-11-30" }],
  };

  test("saves the season against the location found through Catalogue", async () => {
    const { service, seasons } = setup();
    const saved = await service.saveSeason(whaleSeason);
    assert.equal(saved.locationId, hermanus.id);
    assert.deepEqual(seasons[0]?.periods, whaleSeason.periods);
  });

  test("refuses an unknown location with not_found", async () => {
    const { service, seasons } = setup();
    await assert.rejects(
      service.saveSeason({ ...whaleSeason, locationSlug: "atlantis" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal(seasons.length, 0);
  });

  test("refuses a period that ends before it starts", async () => {
    const { service, seasons } = setup();
    await assert.rejects(
      service.saveSeason({ ...whaleSeason, periods: [{ startDate: "2027-11-30", endDate: "2027-06-01" }] }),
      invalidAt("periods.0.endDate"),
    );
    assert.equal(seasons.length, 0);
  });

  test("accepts a period of one day", async () => {
    const { service } = setup();
    await service.saveSeason({ ...whaleSeason, periods: [{ startDate: "2027-06-01", endDate: "2027-06-01" }] });
  });
});

const JAZZ_ID = "00000000-0000-4000-8000-0000000000e1";
const LISTING_A = "00000000-0000-4000-8000-00000000000a";
const LISTING_B = "00000000-0000-4000-8000-00000000000b";

function storedExperience(overrides: Partial<StoredExperience> = {}): StoredExperience {
  return {
    id: JAZZ_ID,
    version: 1,
    locationId: hermanus.id,
    title: "Jazz on the Cliffs",
    slug: "jazz-on-the-cliffs",
    summary: null,
    description: null,
    profile: null,
    type: "single",
    status: "confirmed",
    booking: "open",
    timezone: hermanus.timezone,
    openingHours: null,
    venue: { name: null, address: null, city: null, position: null },
    price: { min: null, max: null, currency: null },
    onSaleAt: null,
    bookingClosesAt: null,
    bookingUrl: null,
    imageUrl: null,
    pageUrl: null,
    recurrence: null,
    sessions: [],
    attributes: {},
    tags: [],
    listingIds: [LISTING_A, LISTING_B],
    ...overrides,
  };
}

function source(overrides: Partial<Source>): Source {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    name: "Organiser pages",
    kind: "web_page",
    locationId: hermanus.id,
    settings: {},
    credentialsSetting: null,
    priority: 0,
    fetchIntervalHours: 168,
    missedRunsBeforeRemoval: 3,
    maxProcessingAttempts: 3,
    active: true,
    ...overrides,
  };
}

// Data processing with a Discovery that records each selection it is asked to send back, and a Catalogue that
// knows Hermanus and the experiences it is given.
function reprocessSetup(experiences: StoredExperience[] = [storedExperience()]) {
  const selections: ListingSelection[] = [];
  const sources = [
    source({ id: "00000000-0000-4000-8000-0000000000f1", name: "Organiser pages" }),
    source({ id: "00000000-0000-4000-8000-0000000000f2", name: "Whale festival" }),
    // The same name as a source in another location.
    source({ id: "00000000-0000-4000-8000-0000000000f3", name: "Whale festival", locationId: "elsewhere" }),
  ];
  const requeueing: Discovery = {
    ...discovery,
    listSources: () => Promise.resolve(sources),
    requeueListings(selection) {
      selections.push(selection);
      // Each selection sends back one listing, named after what was selected.
      const listingIds =
        "listingIds" in selection ? selection.listingIds : [`listing-of-${Object.values(selection).join()}`];
      return Promise.resolve({ requeued: listingIds.length, listingIds });
    },
  };
  const finding: Catalogue = {
    ...catalogue,
    getExperience: (by) =>
      Promise.resolve(experiences.find((one) => ("id" in by ? one.id === by.id : one.slug === by.slug)) ?? null),
  };
  const model = fakeLanguageModel();
  const service = new DataProcessingService({
    repository: {
      upsertAttribute: notUsed,
      upsertTag: notUsed,
      upsertSeason: notUsed,
      listDefinitions: notUsed,
      listTagSlugs: notUsed,
      listSeasons: notUsed,
      appendWarehouseRows: notUsed,
      saveUndefinedValues: notUsed,
    },
    catalogue: finding,
    discovery: requeueing,
    languageModel: model,
    transactions: { run: (work) => work() },
    settings: { horizonMonths: 24, workers: 1 },
    logger: silent,
  });
  return { service, selections, model };
}

describe("DataProcessingService.reprocess", () => {
  test("sends one listing back", async () => {
    const { service, selections } = reprocessSetup();
    assert.deepEqual(await service.reprocess({ listingId: LISTING_A }), { requeued: 1, listingIds: [LISTING_A] });
    assert.deepEqual(selections, [{ listingIds: [LISTING_A] }]);
  });

  test("sends back every listing an experience is linked to, found by its ID or by its slug", async () => {
    const { service, selections } = reprocessSetup();
    const expected = { requeued: 2, listingIds: [LISTING_A, LISTING_B] };
    assert.deepEqual(await service.reprocess({ experienceId: JAZZ_ID }), expected);
    assert.deepEqual(await service.reprocess({ experienceId: "jazz-on-the-cliffs" }), expected);
    assert.deepEqual(selections, [{ listingIds: [LISTING_A, LISTING_B] }, { listingIds: [LISTING_A, LISTING_B] }]);
  });

  test("refuses an experience linked to no listing with invalid_input, and an unknown one with not_found", async () => {
    const { service, selections } = reprocessSetup([storedExperience({ listingIds: [] })]);
    await assert.rejects(
      service.reprocess({ experienceId: JAZZ_ID }),
      (error) =>
        error instanceof AppError && error.code === "invalid_input" && /nothing to process again/.test(error.message),
    );
    await assert.rejects(
      service.reprocess({ experienceId: "no-such-experience" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    await assert.rejects(
      service.reprocess({ experienceId: "00000000-0000-4000-8000-0000000000e9" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.deepEqual(selections, []);
  });

  test("sends back the listings of a source by its name, in every location with a source of that name", async () => {
    const { service, selections } = reprocessSetup();
    assert.deepEqual(await service.reprocess({ sourceName: "Organiser pages" }), {
      requeued: 1,
      listingIds: ["listing-of-00000000-0000-4000-8000-0000000000f1"],
    });
    assert.equal((await service.reprocess({ sourceName: "Whale festival" })).requeued, 2);
    assert.deepEqual(selections, [
      { sourceId: "00000000-0000-4000-8000-0000000000f1" },
      { sourceId: "00000000-0000-4000-8000-0000000000f2" },
      { sourceId: "00000000-0000-4000-8000-0000000000f3" },
    ]);
  });

  test("sends back every listing of a location found by its slug", async () => {
    const { service, selections } = reprocessSetup();
    await service.reprocess({ locationSlug: "hermanus" });
    assert.deepEqual(selections, [{ locationId: hermanus.id }]);
  });

  test("refuses an unknown source or location with not_found", async () => {
    const { service, selections } = reprocessSetup();
    const notFound = (error: unknown) => error instanceof AppError && error.code === "not_found";
    await assert.rejects(service.reprocess({ sourceName: "Nobody's pages" }), notFound);
    await assert.rejects(service.reprocess({ locationSlug: "atlantis" }), notFound);
    assert.deepEqual(selections, []);
  });

  test("only sends listings back: nothing is claimed or processed", async () => {
    const { service, model } = reprocessSetup();
    await service.reprocess({ locationSlug: "hermanus" });
    assert.equal(model.requests.length, 0);
  });
});
