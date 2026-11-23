import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checkClassification,
  type ClassificationAnswer,
  classificationInstructions,
  classificationText,
  seasonsOf,
  withStatedAge,
} from "../src/data-processing/classify.ts";
import type { ExtractedExperience } from "../src/data-processing/extract.ts";
import { CLASSIFICATION_INSTRUCTIONS_INTRODUCTION } from "../src/data-processing/instructions.ts";
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

describe("A stated age limit", () => {
  test("reaches the classifier", () => {
    assert.match(classificationText(experience({ minimumAge: 18 })), /^Age limit the source states: 18$/m);
  });

  test("is the minimum age, and makes the audience adults at 18 or more, whatever the model chose", () => {
    const chosen = { audience: ["family"], category: ["music"] };
    assert.deepEqual(withStatedAge(chosen, 18, definitions), {
      audience: ["adults"],
      category: ["music"],
      minimum_age: [18],
    });
    assert.deepEqual(withStatedAge(chosen, 16, definitions), {
      audience: ["family"],
      category: ["music"],
      minimum_age: [16],
    });
    assert.deepEqual(withStatedAge(chosen, undefined, definitions), chosen);
    // Without the definitions, nothing is added.
    assert.deepEqual(withStatedAge(chosen, 18, { attributes: [], tags: [] }), chosen);
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

  test("the text is the experience's title, summary, description, venue, price and the source's labels", () => {
    assert.equal(
      classificationText(experience({ price: { min: 150, max: 300, currency: "ZAR" } })),
      [
        "Title: Jazz on the Cliffs",
        "Summary: An evening of jazz.",
        "Description: Local players on the cliff path.",
        "Venue: Gearing's Point, Hermanus",
        "Price: ZAR 150 to ZAR 300",
        "The source's labels: Live music, Outdoor",
        "Age limit the source states: none",
      ].join("\n"),
    );
  });

  test("the price says free for 0 and 0, not stated for none, and one amount or an upper limit", () => {
    const price = (value: ExtractedExperience["price"]) =>
      classificationText(experience(value === undefined ? {} : { price: value }))
        .split("\n")
        .find((line) => line.startsWith("Price: "));
    assert.equal(price(undefined), "Price: not stated");
    assert.equal(price({ min: 0, max: 0 }), "Price: free");
    assert.equal(price({ min: 0 }), "Price: free");
    assert.equal(price({ min: 0, max: 250, currency: "ZAR" }), "Price: ZAR 0 to ZAR 250");
    assert.equal(price({ min: 850, currency: "ZAR" }), "Price: ZAR 850");
    assert.equal(price({ max: 400 }), "Price: up to 400");
  });
});

describe("Seasons", () => {
  const horizon = "2028-11-23";
  const seasonsOfSessions = (sessions: ExtractedExperience["sessions"]) => seasonsOf(experience({ sessions }), SEASONS, horizon);

  test("a season applies only when every session is inside one of its periods", () => {
    assert.deepEqual(seasonsOfSessions([{ start: "2027-06-12", end: "2027-06-21", precision: "day" }]), ["whale-season"]);
    assert.deepEqual(seasonsOfSessions([{ start: "2027-03-13", precision: "day" }]), []);
    // A run with one date in whale season and one after it.
    assert.deepEqual(
      seasonsOfSessions([
        { start: "2027-11-20", precision: "day" },
        { start: "2027-12-04", precision: "day" },
      ]),
      [],
    );
    // Days that run from the end of whale season into summer are inside neither.
    assert.deepEqual(seasonsOfSessions([{ start: "2026-11-25", end: "2026-12-05", precision: "day" }]), []);
  });

  test("a month or a year is inside only when the whole of it is", () => {
    assert.deepEqual(seasonsOfSessions([{ start: "2026-11-01", precision: "month" }]), ["whale-season"]);
    assert.deepEqual(seasonsOfSessions([{ start: "2026-12-01", precision: "month" }]), ["summer"]);
    assert.deepEqual(seasonsOfSessions([{ start: "2027-01-01", precision: "year" }]), []);
  });

  test("a recurring experience is in a season only when every day its recurrence gives is", () => {
    const market = experience({
      type: "recurring",
      sessions: [],
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-28" },
    });
    // A market every Saturday of the year is in no season.
    assert.deepEqual(seasonsOf(market, SEASONS, horizon), []);
    const bounded = { ...market, recurrence: { rule: "FREQ=WEEKLY", start: "2026-12-05", end: "2027-01-30" } };
    assert.deepEqual(seasonsOf(bounded, SEASONS, horizon), ["summer"]);
    // An extra date outside the season, listed beside the rule, takes it out.
    assert.deepEqual(seasonsOf({ ...bounded, sessions: [{ start: "2027-03-06", precision: "day" }] }, SEASONS, horizon), []);
    // A skipped date outside the season does not.
    const intoDecember = { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2027-11-20", end: "2027-12-04" };
    assert.deepEqual(seasonsOf({ ...market, recurrence: intoDecember }, SEASONS, horizon), []);
    assert.deepEqual(
      seasonsOf({ ...market, recurrence: { ...intoDecember, skipped: ["2027-12-04"] } }, SEASONS, horizon),
      ["whale-season"],
    );
  });

  test("an open-ended recurrence on only the season's months is in it, as far as the season's periods go", () => {
    const whaleWatching = experience({
      type: "recurring",
      sessions: [],
      recurrence: { rule: "FREQ=DAILY;BYMONTH=6,7,8,9,10,11", start: "2026-11-23" },
    });
    assert.deepEqual(seasonsOf(whaleWatching, SEASONS, horizon), ["whale-season"]);
    const nightMarkets = experience({
      type: "recurring",
      sessions: [],
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=WE;BYMONTH=12,1", start: "2026-12-02" },
    });
    assert.deepEqual(seasonsOf(nightMarkets, SEASONS, horizon), ["summer"]);
  });
});
