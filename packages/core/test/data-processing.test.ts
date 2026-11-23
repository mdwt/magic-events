import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { attribute, attributeOption, season, seasonPeriod, tag } from "@magic-events/db";
import { asc, eq } from "drizzle-orm";
import type { AttributeDefinition, SaveSeasonInput } from "../src/data-processing/ports.ts";
import { AppError } from "../src/shared/errors.ts";
import { createHarness, type Harness } from "../src/testing/harness.ts";

// Saving definitions and seasons against the database, through the Data processing service.

let harness: Harness;

const audience: AttributeDefinition = {
  key: "audience",
  name: "Audience",
  description: "Who it is for",
  type: "option",
  defaultValue: null,
  multiple: false,
  filterable: true,
  options: [
    { key: "family", name: "Family", description: "Made for children and their families" },
    { key: "all_ages", name: "All ages", description: "Open to anyone, children welcome" },
    { key: "adults", name: "Adults", description: "Aimed at adults" },
  ],
};

const whaleSeason: SaveSeasonInput = {
  locationSlug: "hermanus",
  slug: "whale-season",
  name: "Whale season",
  description: "Southern right whales in Walker Bay",
  periods: [
    { startDate: "2026-06-01", endDate: "2026-11-30" },
    { startDate: "2027-06-01", endDate: "2027-11-30" },
  ],
};

before(async () => {
  harness = await createHarness();
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

after(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.delete(attribute);
  await harness.db.delete(tag);
  await harness.db.delete(season);
});

async function optionsOf(key: string) {
  return harness.db
    .select({ key: attributeOption.key, name: attributeOption.name, position: attributeOption.position })
    .from(attributeOption)
    .innerJoin(attribute, eq(attribute.id, attributeOption.attributeId))
    .where(eq(attribute.key, key))
    .orderBy(asc(attributeOption.position));
}

describe("Data processing repository: attributes", () => {
  test("saves the attribute with its options in order", async () => {
    const saved = await harness.services.dataProcessing.saveAttribute(audience);
    assert.deepEqual(saved, audience);
    assert.deepEqual(await optionsOf("audience"), [
      { key: "family", name: "Family", position: 0 },
      { key: "all_ages", name: "All ages", position: 1 },
      { key: "adults", name: "Adults", position: 2 },
    ]);
  });

  test("saving again updates the attribute and replaces its option set", async () => {
    await harness.services.dataProcessing.saveAttribute(audience);
    // All ages is left out, Teens is new, and the order changes.
    const saved = await harness.services.dataProcessing.saveAttribute({
      ...audience,
      description: "Who the experience is for",
      options: [
        { key: "adults", name: "Adults", description: "Aimed at adults" },
        { key: "teens", name: "Teens", description: "Aimed at teenagers" },
        { key: "family", name: "Family", description: "Made for children and their families" },
      ],
    });

    assert.equal(saved.description, "Who the experience is for");
    assert.equal(await harness.db.$count(attribute), 1);
    assert.deepEqual(
      (await optionsOf("audience")).map((option) => option.key),
      ["adults", "teens", "family"],
    );
    assert.deepEqual(
      saved.options.map((option) => option.key),
      ["adults", "teens", "family"],
    );
  });

  test("saves an attribute of another type with no options", async () => {
    const saved = await harness.services.dataProcessing.saveAttribute({
      ...audience,
      key: "minimum_age",
      name: "Minimum age",
      type: "number",
      options: [],
    });
    assert.deepEqual(saved.options, []);
    assert.equal(await harness.db.$count(attributeOption), 0);
  });
});

describe("Data processing repository: tags", () => {
  test("saving a tag again updates the one with that slug", async () => {
    await harness.services.dataProcessing.saveTag({ slug: "jazz", name: "Jazz", description: "Jazz music" });
    const saved = await harness.services.dataProcessing.saveTag({
      slug: "jazz",
      name: "Jazz",
      description: "Jazz, swing and blues",
    });
    assert.equal(saved.description, "Jazz, swing and blues");
    const rows = await harness.db.select().from(tag);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.description, "Jazz, swing and blues");
  });
});

describe("Data processing repository: seasons", () => {
  test("saves the season with its periods in the location found through Catalogue", async () => {
    const saved = await harness.services.dataProcessing.saveSeason(whaleSeason);
    const hermanus = await harness.services.catalogue.getLocation({ slug: "hermanus" });
    assert.equal(saved.locationId, hermanus?.id);
    assert.deepEqual(saved.periods, whaleSeason.periods);
  });

  test("saving again replaces the period set", async () => {
    const first = await harness.services.dataProcessing.saveSeason(whaleSeason);
    const periods = [
      { startDate: "2027-06-01", endDate: "2027-11-30" },
      { startDate: "2028-06-01", endDate: "2028-11-30" },
    ];
    const second = await harness.services.dataProcessing.saveSeason({ ...whaleSeason, periods });

    assert.equal(second.id, first.id);
    assert.deepEqual(second.periods, periods);
    assert.equal(await harness.db.$count(season), 1);
    const rows = await harness.db
      .select({ startDate: seasonPeriod.startDate, endDate: seasonPeriod.endDate })
      .from(seasonPeriod)
      .orderBy(asc(seasonPeriod.startDate));
    assert.deepEqual(rows, periods);
  });

  test("refuses a location Catalogue does not have", async () => {
    await assert.rejects(
      harness.services.dataProcessing.saveSeason({ ...whaleSeason, locationSlug: "atlantis" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal(await harness.db.$count(season), 0);
  });
});
