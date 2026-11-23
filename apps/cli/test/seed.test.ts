import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import {
  apikey,
  attribute,
  attributeOption,
  experience,
  location,
  season,
  seasonPeriod,
  source,
  tag,
  tenant,
  user,
} from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { SearchExperiencesInput } from "@magic-events/core/catalogue/ports.ts";
import { seedDefaults, seedSamples, type DefaultsSeeded } from "../src/seed/seed.ts";
import { createHarness, type Harness } from "@magic-events/core/testing/harness.ts";

let harness: Harness;
let first: DefaultsSeeded;
let second: DefaultsSeeded;
let countsAfterFirst: Record<string, number>;
let countsAfterSecond: Record<string, number>;

const TABLES = { location, attribute, attributeOption, tag, season, seasonPeriod, source, tenant, user, apikey };

async function countRows(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) result[name] = await harness.db.$count(table);
  return result;
}

// ---- The default definitions as docs/data-processing.md writes them ----

const docs = await readFile(new URL("../../../docs/data-processing.md", import.meta.url), "utf8");

// The rows of the markdown table whose header row starts with the given cells.
function table(header: string): string[][] {
  const lines = docs.split("\n");
  const start = lines.findIndex((line) => line.startsWith(header));
  assert.ok(start >= 0, `no table starting with ${header} in docs/data-processing.md`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

function attributeKey(name: string): string {
  return name.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "_");
}

function tagSlug(name: string): string {
  return name.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-");
}

// Option name and description, by attribute key, from the tables that describe each option.
const describedOptions: Record<string, [string, string][]> = {
  category: table("| Category | Description |").map(([name = "", description = ""]) => [name, description]),
  format: table("| Format | Description |").map(([name = "", description = ""]) => [name, description]),
  audience: table("| Audience | Description |").map(([name = "", description = ""]) => [name, description]),
};

// The attribute table: name, type, values, default.
const documentedAttributes = table("| Attribute | Type | Values | Default | Says |").map(
  ([name = "", type = "", values = "", byDefault = ""]) => ({ name, type, values, byDefault }),
);

const documentedTags = table("| Usually with | Tags |").flatMap(([, list = ""]) =>
  list.split(",").map((one) => tagSlug(one.trim())),
);

before(async () => {
  harness = await createHarness();
  first = await seedDefaults(harness.services);
  countsAfterFirst = await countRows();
  second = await seedDefaults(harness.services);
  countsAfterSecond = await countRows();
});

after(async () => {
  await harness.close();
});

describe("seedDefaults", () => {
  test("a second run leaves the same rows", () => {
    assert.deepEqual(countsAfterSecond, countsAfterFirst);
    assert.equal(countsAfterFirst.location, 1);
    assert.equal(countsAfterFirst.tenant, 2);
    assert.equal(countsAfterFirst.user, 3);
    assert.equal(countsAfterFirst.apikey, 5);
  });

  test("a second run issues no new key", () => {
    assert.equal(first.issued.length, 5);
    assert.equal(second.issued.length, 0);
  });

  test("every default attribute in the docs is there, with its type, multiplicity and default", async () => {
    assert.equal(documentedAttributes.length, 9);
    const rows = await harness.db.select().from(attribute);
    assert.equal(rows.length, documentedAttributes.length);
    for (const documented of documentedAttributes) {
      const row = rows.find((one) => one.key === attributeKey(documented.name));
      assert.ok(row, `attribute ${documented.name} is missing`);
      assert.equal(row.name, documented.name);
      const type = documented.type.replace(", several values", "");
      assert.equal(row.type, { Option: "option", Number: "number", "True/false": "boolean" }[type]);
      assert.equal(row.multiple, documented.type.endsWith("several values"), `multiple of ${documented.name}`);
      const byDefault = documented.byDefault === "None" ? null : attributeKey(documented.byDefault);
      assert.equal(row.defaultValue, byDefault, `default of ${documented.name}`);
    }
  });

  test("every documented option is there, with its description as written", async () => {
    const rows = await harness.db
      .select({
        attribute: attribute.key,
        key: attributeOption.key,
        name: attributeOption.name,
        description: attributeOption.description,
      })
      .from(attributeOption)
      .innerJoin(attribute, eq(attribute.id, attributeOption.attributeId));

    for (const [attributeName, options] of Object.entries(describedOptions)) {
      for (const [name, description] of options) {
        const row = rows.find((one) => one.attribute === attributeName && one.key === attributeKey(name));
        assert.ok(row, `option ${name} of ${attributeName} is missing`);
        assert.equal(row.name, name);
        assert.equal(row.description, description);
      }
    }

    // Language, setting and scale list their values in the attribute table.
    for (const documented of documentedAttributes.filter((one) => one.type.startsWith("Option"))) {
      const key = attributeKey(documented.name);
      const stored = rows.filter((one) => one.attribute === key).map((one) => one.key).sort();
      const expected =
        key in describedOptions
          ? (describedOptions[key] ?? []).map(([name]) => attributeKey(name))
          : documented.values.split(",").map((value) => attributeKey(value.trim()));
      assert.deepEqual(stored, [...expected].sort(), `options of ${documented.name}`);
    }
    for (const row of rows) assert.ok(row.description.length > 0, `option ${row.key} has no description`);
  });

  test("every documented tag is there, with a description", async () => {
    assert.ok(documentedTags.includes("rock-and-pop") && documentedTags.includes("new-years-eve"));
    const rows = await harness.db.select().from(tag);
    assert.deepEqual(rows.map((row) => row.slug).sort(), [...documentedTags].sort());
    for (const row of rows) assert.ok(row.description.length > 0, `tag ${row.slug} has no description`);
  });

  test("the seeded keys authenticate as their users, with the right kind", async () => {
    for (const issued of first.issued) {
      const caller = await harness.services.identity.authenticate(issued.key);
      assert.equal(caller.kind, issued.kind);
      const [row] = await harness.db.select().from(user).where(eq(user.id, caller.userId));
      assert.equal(row?.email, issued.email);
    }
    const kinds = first.issued.map((issued) => `${issued.email} ${issued.kind}`).sort();
    assert.deepEqual(kinds, [
      "admin@example.com person",
      "planner@agency.example.com agent",
      "planner@agency.example.com person",
      "planner@app.example.com agent",
      "planner@app.example.com person",
    ]);
  });

  test("the admin belongs to no tenant and the clients to theirs", async () => {
    for (const issued of first.issued) {
      const caller = await harness.services.identity.authenticate(issued.key);
      if (issued.email === "admin@example.com") {
        assert.equal(caller.role, "system_admin");
        assert.equal(caller.tenant, null);
      } else {
        assert.equal(caller.role, "client");
        assert.equal(caller.tenant?.status, "active");
      }
    }
  });
});

describe("seedSamples", () => {
  const today = new Date("2026-11-23T08:00:00Z");
  const hermanus = { lat: -34.4187, lng: 19.2345 };
  const june2027: SearchExperiencesInput = {
    near: hermanus,
    from: "2027-06-01",
    to: "2027-06-30",
    limit: 100,
    offset: 0,
  };

  test("a second run creates no duplicates", async () => {
    const once = await seedSamples(harness.services, harness.db, { today });
    const experiences = await harness.db.$count(experience);
    const twice = await seedSamples(harness.services, harness.db, { today });

    assert.equal(once.inserted.length, 10);
    assert.equal(twice.inserted.length, 0);
    assert.equal(twice.skipped.length, 10);
    assert.equal(await harness.db.$count(experience), experiences);
  });

  test("a search around Hermanus for June 2027 finds FynArts and a Saturday market session", async () => {
    const result = await harness.services.catalogue.searchExperiences(june2027);
    const titles = result.items.map((item) => item.title);

    const fynarts = result.items.find((item) => item.title === "Hermanus FynArts 2027");
    assert.ok(fynarts, `FynArts not found in ${titles.join(", ")}`);
    assert.equal(fynarts.sessions[0]?.precision, "month");

    const market = result.items.find((item) => item.title === "Hermanus Country Market");
    assert.ok(market, `the market not found in ${titles.join(", ")}`);
    assert.ok(market.sessions.length >= 4);
    for (const session of market.sessions) {
      assert.equal(new Date(`${session.startDate}T00:00:00Z`).getUTCDay(), 6, `${session.startDate} is a Saturday`);
    }

    // Cancelled and past experiences are left out, and Cape Town is outside the default radius.
    assert.ok(!titles.includes("Whale Coast Food and Wine Fair"));
    assert.ok(!titles.includes("Carols by Candlelight 2025"));
    assert.ok(!titles.includes("Winter Symphony at the City Hall"));
  });

  test("a wide enough radius reaches the sample in Cape Town", async () => {
    const result = await harness.services.catalogue.searchExperiences({ ...june2027, radiusKm: 150 });
    assert.ok(result.items.some((item) => item.title === "Winter Symphony at the City Hall"));
  });
});
