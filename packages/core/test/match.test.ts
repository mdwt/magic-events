import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtractedExperience } from "../src/data-processing/extract.ts";
import {
  matchInCode,
  matchLinked,
  matchText,
  nearDates,
  normaliseTitle,
  onlyMonthOrYear,
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

  test("dates known only to the month need only be near, on either side, and day dates on both sides must overlap", () => {
    const september: ExtractedExperience = {
      ...fynArts,
      title: "Hermanus Whale Festival",
      sessions: [{ start: "2027-09-01", precision: "month" }],
    };
    const september2027 = { start: "2027-09-01", end: "2027-09-30" };
    const october = { title: "Hermanus Whale Festival", firstDate: "2027-10-01", lastDate: "2027-10-31" };
    // The extracted one is known to the month, the stored one to the day, or the other way round.
    assert.ok(matchInCode(september, september2027, [stored({ ...october, onlyMonthOrYear: true })]));
    assert.ok(matchInCode(september, september2027, [stored({ ...october, lastDate: "2027-10-03" })]));
    const daysInSeptember = { ...september, sessions: [{ start: "2027-09-24", end: "2027-09-26", precision: "day" as const }] };
    assert.ok(matchInCode(daysInSeptember, { start: "2027-09-24", end: "2027-09-26" }, [stored({ ...october, onlyMonthOrYear: true })]));
    // Days on both sides keep the rule that they overlap, so two editions stay two experiences.
    assert.equal(matchInCode(daysInSeptember, { start: "2027-09-24", end: "2027-09-26" }, [stored({ ...october, lastDate: "2027-10-03" })]), undefined);
    // Next year's edition is not near, even known only to the month.
    const nextYear = stored({ ...october, firstDate: "2028-09-01", lastDate: "2028-09-30", onlyMonthOrYear: true });
    assert.equal(matchInCode(september, september2027, [nextYear]), undefined);
  });

  test("near dates are the whole of the span's years and three months either side", () => {
    assert.deepEqual(nearDates({ start: "2027-09-01", end: "2027-09-30" }), { start: "2027-01-01", end: "2027-12-31" });
    assert.deepEqual(nearDates({ start: "2027-12-01", end: "2027-12-31" }), { start: "2027-01-01", end: "2028-03-31" });
    assert.deepEqual(nearDates({ start: "2028-01-01", end: "2028-01-31" }), { start: "2027-10-01", end: "2028-12-31" });
  });

  test("only month or year precision, with no recurrence, is dates known only to the month or year", () => {
    assert.equal(onlyMonthOrYear(fynArts), false);
    assert.equal(onlyMonthOrYear({ ...fynArts, sessions: [{ start: "2027-01-01", precision: "year" }] }), true);
    const mixed = { ...fynArts, sessions: [...fynArts.sessions, { start: "2027-09-01", precision: "month" as const }] };
    assert.equal(onlyMonthOrYear(mixed), false);
    const recurring = { ...fynArts, sessions: [], recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2027-01-02" } };
    assert.equal(onlyMonthOrYear(recurring), false);
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
  const own = (priority: number) => ({ listingId: LISTING, priority });
  const other = (priority: number) => ({ listingId: OTHER_LISTING, priority });

  test("leads when this listing's source has a higher priority than every other linked listing's, and fills when lower", () => {
    assert.equal(precedenceOf(own(20), [other(10), own(20)]), "lead");
    assert.equal(precedenceOf(own(20), [other(10)]), "lead");
    assert.equal(precedenceOf(own(10), [own(10), other(20)]), "fill");
    assert.equal(precedenceOf(own(10), []), "lead");
  });

  test("on a tie in priority, the listing linked first keeps the lead, and one not linked yet only fills", () => {
    assert.equal(precedenceOf(own(10), [own(10), other(10)]), "lead");
    assert.equal(precedenceOf(own(10), [other(10), own(10)]), "fill");
    assert.equal(precedenceOf(own(10), [other(10)]), "fill");
    // A tie below the highest priority does not matter: the highest leads.
    assert.equal(precedenceOf(own(10), [{ listingId: "third", priority: 30 }, own(10), other(10)]), "fill");
  });
});
