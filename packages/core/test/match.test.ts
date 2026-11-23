import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtractedExperience } from "../src/data-processing/extract.ts";
import {
  matchInCode,
  matchLinked,
  matchText,
  normaliseTitle,
  pickedCandidate,
  precedenceOf,
} from "../src/data-processing/match.ts";
import { LISTING, OTHER_LISTING, stored } from "./fixtures/processing/fakes.ts";

const fynArts: ExtractedExperience = {
  title: "The Hermanus FynArts Festival 2027",
  type: "single",
  status: "announced",
  booking: "not_yet",
  sessions: [{ start: "2027-06-12", end: "2027-06-21", precision: "day" }],
  venue: { city: "Hermanus" },
  hints: [],
};
const span = { start: "2027-06-12", end: "2027-06-21" };

describe("Titles", () => {
  test("are compared with case, accents, punctuation, the year and a leading article taken out", () => {
    assert.equal(normaliseTitle("The Hermanus FynArts Festival 2027"), "hermanus fynarts festival");
    assert.equal(normaliseTitle("Hermanus Fynarts — festival!"), "hermanus fynarts festival");
    assert.equal(normaliseTitle("Café Crème: Kaapse Klopse"), "cafe creme kaapse klopse");
    assert.equal(normaliseTitle("'n Aand by die see"), "aand by die see");
    assert.equal(normaliseTitle("Die Kalfiefees"), "kalfiefees");
  });
});

describe("Matching in code", () => {
  test("the same normalised title with overlapping dates is a match", () => {
    const candidate = stored({ title: "Hermanus FynArts Festival" });
    assert.equal(matchInCode(fynArts, span, [stored({ id: "other", title: "Whale Festival" }), candidate]), candidate);
  });

  test("the same title with dates that do not overlap is not", () => {
    const lastYear = stored({ title: "Hermanus FynArts Festival", firstDate: "2026-06-13", lastDate: "2026-06-22" });
    assert.equal(matchInCode(fynArts, span, [lastYear]), undefined);
  });

  test("an open-ended candidate overlaps anything after its first date", () => {
    const market = stored({ title: "Hermanus FynArts Festival", firstDate: "2026-01-03", lastDate: null });
    assert.equal(matchInCode(fynArts, span, [market]), market);
  });

  test("among the listing's own links only the title is compared, since the listing moves their dates", () => {
    const moved = stored({ title: "Hermanus FynArts Festival", firstDate: "2027-05-01", lastDate: "2027-05-10" });
    assert.equal(matchLinked(fynArts, [moved]), moved);
    assert.equal(matchLinked(fynArts, [stored({ title: "Whale Festival" })]), undefined);
  });
});

describe("The model's pick", () => {
  test("counts only when it is one of the candidates", () => {
    const candidate = stored({ id: "a" });
    assert.equal(pickedCandidate({ experienceId: " a " }, [candidate]), candidate);
    assert.equal(pickedCandidate({ experienceId: "made-up" }, [candidate]), undefined);
    assert.equal(pickedCandidate({ experienceId: "" }, [candidate]), undefined);
  });

  test("the model is shown the experience and every candidate with its ID, venue and dates", () => {
    const text = matchText(fynArts, span, [stored({ id: "a", venueName: "Town hall", recurrenceRule: null })]);
    assert.match(text, /Title: The Hermanus FynArts Festival 2027/);
    assert.match(text, /Dates: 2027-06-12 to 2027-06-21/);
    assert.match(text, /- ID a: Hermanus FynArts; venue: Town hall, Hermanus; dates: 2027-06-12 to 2027-06-21/);
  });
});

describe("Precedence", () => {
  test("leads when this listing's source has the highest priority, ties included, and fills otherwise", () => {
    assert.equal(precedenceOf(20, LISTING, { [LISTING]: 20, [OTHER_LISTING]: 10 }), "lead");
    assert.equal(precedenceOf(10, LISTING, { [LISTING]: 10, [OTHER_LISTING]: 10 }), "lead");
    assert.equal(precedenceOf(10, LISTING, { [LISTING]: 10, [OTHER_LISTING]: 20 }), "fill");
    assert.equal(precedenceOf(10, LISTING, {}), "lead");
  });
});
