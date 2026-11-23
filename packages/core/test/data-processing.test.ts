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

// Every column of the attribute's row and of its option rows, the options by key.
async function storedAttribute(key: string) {
  const [row] = await harness.db.select().from(attribute).where(eq(attribute.key, key));
  assert.ok(row, `no attribute ${key}`);
  const options = await harness.db
    .select()
    .from(attributeOption)
    .where(eq(attributeOption.attributeId, row.id))
    .orderBy(asc(attributeOption.key));
  return { row, options: Object.fromEntries(options.map((option) => [option.key, option])) };
}

// Every column of the season's row and of its period rows, the periods by start date.
async function storedSeason(slug: string) {
  const [row] = await harness.db.select().from(season).where(eq(season.slug, slug));
  assert.ok(row, `no season ${slug}`);
  const periods = await harness.db
    .select()
    .from(seasonPeriod)
    .where(eq(seasonPeriod.seasonId, row.id))
    .orderBy(asc(seasonPeriod.startDate));
  return { row, periods: Object.fromEntries(periods.map((period) => [period.startDate, period])) };
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

  test("saving the attribute as it is stored changes no column of it or of its options", async () => {
    await harness.services.dataProcessing.saveAttribute(audience);
    const before = await storedAttribute("audience");
    const saved = await harness.services.dataProcessing.saveAttribute(audience);
    assert.deepEqual(saved, audience);
    assert.deepEqual(await storedAttribute("audience"), before);
  });

  test("saving a change to the attribute updates it and updated_at, and leaves its options' rows alone", async () => {
    await harness.services.dataProcessing.saveAttribute(audience);
    const before = await storedAttribute("audience");
    await harness.services.dataProcessing.saveAttribute({ ...audience, filterable: false });
    const after = await storedAttribute("audience");
    assert.deepEqual({ ...after.row, updatedAt: before.row.updatedAt }, { ...before.row, filterable: false });
    assert.ok(after.row.updatedAt > before.row.updatedAt);
    assert.deepEqual(after.options, before.options);
  });

  test("an added, a removed, a changed and a moved option change only their rows, and the attribute's updated_at", async () => {
    await harness.services.dataProcessing.saveAttribute(audience);
    const before = await storedAttribute("audience");
    // Family's description changes, All ages goes, Adults moves up and Teens is new.
    const saved = await harness.services.dataProcessing.saveAttribute({
      ...audience,
      options: [
        { key: "family", name: "Family", description: "For children and their families" },
        { key: "adults", name: "Adults", description: "Aimed at adults" },
        { key: "teens", name: "Teens", description: "Aimed at teenagers" },
      ],
    });
    assert.deepEqual(
      saved.options.map((option) => option.key),
      ["family", "adults", "teens"],
    );

    const after = await storedAttribute("audience");
    assert.deepEqual({ ...after.row, updatedAt: before.row.updatedAt }, before.row);
    assert.ok(after.row.updatedAt > before.row.updatedAt);
    assert.deepEqual(Object.keys(after.options), ["adults", "family", "teens"]);
    assert.deepEqual(after.options.family, { ...before.options.family, description: "For children and their families" });
    assert.deepEqual(after.options.adults, { ...before.options.adults, position: 1 });
    const teens = after.options.teens;
    assert.ok(teens);
    assert.ok(!Object.values(before.options).some((option) => option.id === teens.id));
    assert.equal(teens.position, 2);
  });

  test("reordering the options changes only the positions of the ones that moved", async () => {
    await harness.services.dataProcessing.saveAttribute(audience);
    const before = await storedAttribute("audience");
    const [family, allAges, adults] = audience.options;
    assert.ok(family && allAges && adults);
    await harness.services.dataProcessing.saveAttribute({ ...audience, options: [allAges, family, adults] });

    const after = await storedAttribute("audience");
    assert.deepEqual(after.options, {
      adults: before.options.adults,
      all_ages: { ...before.options.all_ages, position: 0 },
      family: { ...before.options.family, position: 1 },
    });
    assert.deepEqual((await optionsOf("audience")).map((option) => option.key), ["all_ages", "family", "adults"]);
    assert.ok(after.row.updatedAt > before.row.updatedAt);
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

  test("saving a tag as it is stored changes no column, and saving a change updates it and updated_at", async () => {
    const jazz = { slug: "jazz", name: "Jazz", description: "Jazz music" };
    await harness.services.dataProcessing.saveTag(jazz);
    const [before] = await harness.db.select().from(tag);
    assert.ok(before);

    await harness.services.dataProcessing.saveTag(jazz);
    assert.deepEqual(await harness.db.select().from(tag), [before]);

    await harness.services.dataProcessing.saveTag({ ...jazz, name: "Jazz and blues" });
    const [after] = await harness.db.select().from(tag);
    assert.ok(after);
    assert.deepEqual({ ...after, updatedAt: before.updatedAt }, { ...before, name: "Jazz and blues" });
    assert.ok(after.updatedAt > before.updatedAt);
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

  test("saving the season as it is stored changes no column of it or of its periods, in whatever order they come", async () => {
    await harness.services.dataProcessing.saveSeason(whaleSeason);
    const before = await storedSeason("whale-season");
    await harness.services.dataProcessing.saveSeason(whaleSeason);
    assert.deepEqual(await storedSeason("whale-season"), before);
    await harness.services.dataProcessing.saveSeason({ ...whaleSeason, periods: [...whaleSeason.periods].reverse() });
    assert.deepEqual(await storedSeason("whale-season"), before);
  });

  test("saving a change to the season updates it and updated_at, and leaves its periods' rows alone", async () => {
    await harness.services.dataProcessing.saveSeason(whaleSeason);
    const before = await storedSeason("whale-season");
    await harness.services.dataProcessing.saveSeason({ ...whaleSeason, name: "Whale watching season" });
    const after = await storedSeason("whale-season");
    assert.deepEqual({ ...after.row, updatedAt: before.row.updatedAt }, { ...before.row, name: "Whale watching season" });
    assert.ok(after.row.updatedAt > before.row.updatedAt);
    assert.deepEqual(after.periods, before.periods);
  });

  test("an added, a removed and a changed period change only their rows, and the season's updated_at", async () => {
    await harness.services.dataProcessing.saveSeason(whaleSeason);
    const before = await storedSeason("whale-season");
    // 2026 goes, 2027 ends a fortnight earlier and 2028 is new.
    const saved = await harness.services.dataProcessing.saveSeason({
      ...whaleSeason,
      periods: [
        { startDate: "2028-06-01", endDate: "2028-11-30" },
        { startDate: "2027-06-01", endDate: "2027-11-15" },
      ],
    });
    assert.deepEqual(saved.periods, [
      { startDate: "2027-06-01", endDate: "2027-11-15" },
      { startDate: "2028-06-01", endDate: "2028-11-30" },
    ]);

    const after = await storedSeason("whale-season");
    assert.deepEqual({ ...after.row, updatedAt: before.row.updatedAt }, before.row);
    assert.ok(after.row.updatedAt > before.row.updatedAt);
    assert.deepEqual(Object.keys(after.periods), ["2027-06-01", "2028-06-01"]);
    assert.deepEqual(after.periods["2027-06-01"], { ...before.periods["2027-06-01"], endDate: "2027-11-15" });
    const added = after.periods["2028-06-01"];
    assert.ok(added);
    assert.ok(!Object.values(before.periods).some((period) => period.id === added.id));
  });

  test("the tag slugs are every tag's and every season's, in order and each once", async () => {
    await harness.services.dataProcessing.saveTag({ slug: "jazz", name: "Jazz", description: "Jazz music" });
    await harness.services.dataProcessing.saveTag({ slug: "art", name: "Art", description: "Art" });
    await harness.services.dataProcessing.saveSeason(whaleSeason);
    assert.deepEqual(await harness.services.dataProcessing.listTagSlugs(), ["art", "jazz", whaleSeason.slug].sort());
  });

  test("refuses a location Catalogue does not have", async () => {
    await assert.rejects(
      harness.services.dataProcessing.saveSeason({ ...whaleSeason, locationSlug: "atlantis" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal(await harness.db.$count(season), 0);
  });
});
