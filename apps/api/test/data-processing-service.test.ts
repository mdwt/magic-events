import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Catalogue, Location } from "../src/core/catalogue/ports.ts";
import type {
  AttributeDefinition,
  DataProcessingRepository,
  SaveSeasonInput,
  Season,
} from "../src/core/data-processing/ports.ts";
import { DataProcessingService } from "../src/core/data-processing/service.ts";
import { AppError } from "../src/core/shared/errors.ts";
import type { Discovery } from "../src/core/discovery/ports.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import { fakeLanguageModel } from "./helpers/fake-language-model.ts";

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
  findExperiencesByListing: notUsed,
  findMatchCandidates: notUsed,
  saveExperience: notUsed,
  removeSourceLink: notUsed,
};

const discovery: Discovery = {
  saveSource: notUsed,
  listSources: notUsed,
  findDueSources: notUsed,
  runSource: notUsed,
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
