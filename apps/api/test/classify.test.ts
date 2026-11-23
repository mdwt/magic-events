import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checkClassification,
  type ClassificationAnswer,
  classificationInstructions,
  classificationText,
  seasonsOf,
} from "../src/core/data-processing/classify.ts";
import type { ExtractedExperience } from "../src/core/data-processing/extract.ts";
import { CLASSIFICATION_INSTRUCTIONS_INTRODUCTION } from "../src/core/data-processing/instructions.ts";
import { ATTRIBUTES, SEASONS, TAGS } from "./fixtures/processing/fakes.ts";

const definitions = { attributes: ATTRIBUTES, tags: TAGS };

function check(answer: Partial<ClassificationAnswer>) {
  return checkClassification({ attributes: [], tags: [], profile: "A profile.", ...answer }, definitions);
}

function experience(overrides: Partial<ExtractedExperience> = {}): ExtractedExperience {
  return {
    title: "Jazz on the Cliffs",
    summary: "An evening of jazz.",
    description: "Local players on the cliff path.",
    type: "single",
    status: "confirmed",
    booking: "open",
    sessions: [{ start: "2027-03-13", precision: "day" }],
    venue: { name: "Gearing's Point", city: "Hermanus" },
    hints: ["Live music", "Outdoor"],
    ...overrides,
  };
}

describe("Classification against the definitions", () => {
  test("keeps defined values and tags, by key or by name whatever the case", () => {
    const result = check({
      attributes: [
        { key: "category", values: ["music", "Food and drink"] },
        { key: "Audience", values: ["adults"] },
        { key: "minimum_age", values: ["18"] },
        { key: "wheelchair_accessible", values: ["true"] },
      ],
      tags: ["jazz", "Wine", "jazz"],
    });
    assert.deepEqual(result.attributes, {
      category: ["music", "food_and_drink"],
      audience: ["adults"],
      minimum_age: [18],
      wheelchair_accessible: [true],
      scale: ["local"],
    });
    assert.deepEqual(result.tags, ["jazz", "wine"]);
    assert.deepEqual(result.undefinedValues, []);
    assert.equal(result.profile, "A profile.");
  });

  test("an attribute, option or tag that is not defined is kept off and reported", () => {
    const result = check({
      attributes: [
        { key: "mood", values: ["romantic"] },
        { key: "category", values: ["music", "astronomy"] },
      ],
      tags: ["jazz", "stargazing"],
    });
    assert.deepEqual(result.attributes.category, ["music"]);
    assert.equal(result.attributes.mood, undefined);
    assert.deepEqual(result.tags, ["jazz"]);
    assert.deepEqual(result.undefinedValues, [
      { kind: "attribute", value: "mood" },
      { kind: "option", value: "category:astronomy" },
      { kind: "tag", value: "stargazing" },
    ]);
  });

  test("a value that does not fit the attribute's type is left off, and is not an undefined value", () => {
    const result = check({
      attributes: [
        { key: "minimum_age", values: ["eighteen"] },
        { key: "wheelchair_accessible", values: ["yes"] },
      ],
    });
    assert.equal(result.attributes.minimum_age, undefined);
    assert.equal(result.attributes.wheelchair_accessible, undefined);
    assert.deepEqual(result.undefinedValues, []);
    assert.equal(result.misfits.length, 2);
  });

  test("a single-valued attribute gets one value", () => {
    const result = check({ attributes: [{ key: "audience", values: ["family", "adults"] }] });
    assert.deepEqual(result.attributes.audience, ["family"]);
    assert.equal(result.misfits.length, 1);
  });

  test("an attribute with no value gets its default, and one with no default gets nothing", () => {
    assert.deepEqual(check({}).attributes, { scale: ["local"] });
    assert.deepEqual(check({ attributes: [{ key: "scale", values: ["major"] }] }).attributes, { scale: ["major"] });
  });

  test("an empty profile is no profile", () => {
    assert.equal(check({ profile: "  " }).profile, undefined);
  });
});

describe("What the classifier is given", () => {
  test("the instructions carry every attribute with its options and every tag, with their descriptions", () => {
    const instructions = classificationInstructions(definitions);
    assert.ok(instructions.startsWith(CLASSIFICATION_INSTRUCTIONS_INTRODUCTION));
    assert.match(instructions, /category \(Category; option, several values\): What it is about/);
    assert.match(instructions, /- visual_arts \(Visual arts\): Exhibitions/);
    assert.match(instructions, /audience \(Audience; option, one value\): Who it is for/);
    assert.match(instructions, /minimum_age \(Minimum age; number\): The age limit a source states/);
    assert.match(instructions, /- jazz \(Jazz\): Jazz music/);
  });

  test("the text is the experience's title, summary, description, venue and the source's labels", () => {
    assert.equal(
      classificationText(experience()),
      [
        "Title: Jazz on the Cliffs",
        "Summary: An evening of jazz.",
        "Description: Local players on the cliff path.",
        "Venue: Gearing's Point, Hermanus",
        "The source's labels: Live music, Outdoor",
      ].join("\n"),
    );
  });
});

describe("Seasons", () => {
  test("a season applies when one of its periods overlaps a session", () => {
    assert.deepEqual(seasonsOf(experience({ sessions: [{ start: "2027-06-12", end: "2027-06-21", precision: "day" }] }), SEASONS, "2028-11-23"), [
      "whale-season",
    ]);
    assert.deepEqual(seasonsOf(experience({ sessions: [{ start: "2027-03-13", precision: "day" }] }), SEASONS, "2028-11-23"), []);
    assert.deepEqual(
      seasonsOf(experience({ sessions: [{ start: "2026-11-01", precision: "month" }] }), SEASONS, "2028-11-23"),
      ["whale-season"],
    );
  });

  test("a recurring experience is in every season its recurrence spans up to the horizon", () => {
    const market = experience({
      type: "recurring",
      sessions: [],
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-28" },
    });
    assert.deepEqual(seasonsOf(market, SEASONS, "2028-11-23").sort(), ["summer", "whale-season"]);
    assert.deepEqual(seasonsOf({ ...market, recurrence: { rule: "FREQ=WEEKLY", start: "2026-12-05", end: "2027-01-30" } }, SEASONS, "2028-11-23"), [
      "summer",
    ]);
  });
});
