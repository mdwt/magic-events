import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { attributes } from "../src/data-processing/default-attributes.ts";

// The default attribute definitions are written twice: as rows the seed saves, and in docs/data-processing.md
// ("Default definitions"), which people read. These tests keep the two the same.

const doc = readFileSync(new URL("../../../docs/data-processing.md", import.meta.url), "utf8");
const section = doc.slice(doc.indexOf("### Default definitions"), doc.indexOf("### Profile"));

// The rows of the table whose header starts with the given cells, as lists of cells.
function table(...header: string[]): string[][] {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`| ${header.join(" | ")} |`));
  assert.notEqual(start, -1, `a table headed ${header.join(", ")}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

describe("the default attribute definitions and docs/data-processing.md", () => {
  test("list the same attributes, in the same order, with the same defaults", () => {
    const rows = table("Attribute", "Type", "Values", "Default", "Says");
    assert.deepEqual(
      rows.map((row) => row[0]),
      attributes.map((attribute) => attribute.name),
    );
    for (const attribute of attributes) {
      const row = rows.find((one) => one[0] === attribute.name);
      const option = attribute.options.find((one) => one.key === attribute.defaultValue);
      assert.equal(row?.[3], option?.name ?? "None", attribute.key);
    }
  });

  test("tier's options are the table's, in order, with the descriptions the classifier reads", () => {
    const tier = attributes.find((attribute) => attribute.key === "tier");
    assert.ok(tier);
    assert.deepEqual(
      [tier.type, tier.multiple, tier.filterable, tier.defaultValue],
      ["option", false, true, "standard"],
    );
    assert.deepEqual(
      table("Tier", "Description"),
      tier.options.map((option) => [option.name, option.description]),
    );
    const row = table("Attribute", "Type", "Values", "Default", "Says").find((one) => one[0] === "Tier");
    assert.equal(row?.[2], tier.options.map((option) => option.name).join(", "));
    assert.deepEqual(
      tier.options.map((option) => option.key),
      ["luxury", "premium", "standard", "everyday"],
    );
  });
});
