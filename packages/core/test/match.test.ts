import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtractedExperience } from "../src/data-processing/extract.ts";
import { MATCH_INSTRUCTIONS } from "../src/data-processing/instructions.ts";
import {
  datesFit,
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

  test("two operators' whale watching trips from New Harbour are not matched in code, though their dates fit", () => {
    // As data/hermanus/extracted/hermanus-whale-cruises.json and southern-right-charters.json have them.
    const whaleCruises: ExtractedExperience = {
      title: "Hermanus Whale Cruises boat-based whale watching",
      type: "recurring",
      status: "confirmed",
      booking: "open",
      sessions: [],
      recurrence: { rule: "FREQ=DAILY;BYMONTH=6,7,8,9,10,11", start: "2026-11-23" },
      venue: { name: "New Harbour", address: "148 Westcliff Road, Hermanus", city: "Hermanus" },
      hints: [],
    };
    const southernRight = stored({
      title: "Boat-based whale watching with Southern Right Charters",
      type: "recurring",
      venueName: "The Whale Shack, New Harbour",
      city: "Hermanus",
      firstDate: "2026-11-23",
      lastDate: null,
      sessions: [{ startDate: "2026-11-23", endDate: "2026-11-23", startTime: null }],
      recurrenceRule: "FREQ=DAILY;BYMONTH=6,7,8,9,10,11",
    });
    const whaleSpan = { start: "2026-11-23", end: "2028-11-23" };
    assert.ok(datesFit(whaleCruises, whaleSpan, southernRight));
    assert.equal(matchInCode(whaleCruises, whaleSpan, [southernRight]), undefined);
    // The model is asked instead, and is told that another operator's trip is another experience.
    assert.match(MATCH_INSTRUCTIONS, /different operator or organiser/);
  });

  test("a series known by its month takes no dated concert by an act in it, in code", () => {
    // From data/hermanus/extracted: the Whale Coast calendar's "Sunset Sessions" for December 2026, and AllEvents'
    // dated concerts of the series.
    const sunsetSessions = stored({
      title: "Sunset Sessions",
      venueName: "Stanford Hills Estate",
      city: "Stanford",
      firstDate: "2026-12-01",
      lastDate: "2026-12-31",
      sessions: [{ startDate: "2026-12-01", endDate: "2026-12-31", startTime: null }],
      onlyMonthOrYear: true,
    });
    for (const [title, day] of [
      ["Jeremy Loops Live at Stanford Hills Sunset Sessions", "2026-12-23"],
      ["Jesse Clegg and Ross Learmonth Live at Stanford Hills Sunset Sessions", "2026-12-30"],
      ["Matthew Mole at Stanford Hills Sunset Sessions", "2026-12-26"],
      ["Will Linley Live at Stanford Hills Sunset Sessions", "2026-12-28"],
    ] as const) {
      const concert: ExtractedExperience = {
        ...fynArts,
        title,
        sessions: [{ start: day, precision: "day", startTime: "15:00" }],
        venue: { name: "Stanford Hills Estate", city: "Stanford" },
      };
      const days = { start: day, end: day };
      assert.ok(datesFit(concert, days, sunsetSessions));
      assert.equal(matchInCode(concert, days, [sunsetSessions]), undefined);
      // The model is shown that the series is known only by its month.
      assert.match(matchText(concert, days, [sunsetSessions]), /dates: 2026-12-01 to 2026-12-31 \(only the month or year is known\)/);
    }
  });

  test("a festival announced by its month is still one experience with its days, or with another source's month", () => {
    const kalfiefees = stored({
      title: "Kalfiefees Hermanus Kunstefees 2027",
      firstDate: "2027-08-01",
      lastDate: "2027-08-31",
      sessions: [{ startDate: "2027-08-01", endDate: "2027-08-31", startTime: null }],
      onlyMonthOrYear: true,
    });
    // The days, when a source gives them (the dates here are made up; the capture has only August).
    const withDays: ExtractedExperience = {
      ...fynArts,
      title: "Kalfiefees Hermanus Kunstefees",
      sessions: [{ start: "2027-08-12", end: "2027-08-15", precision: "day" }],
    };
    assert.equal(matchInCode(withDays, { start: "2027-08-12", end: "2027-08-15" }, [kalfiefees]), kalfiefees);
    // SA-Venues' Hermanus Whale Festival in October 2027, against another source's September.
    const october: ExtractedExperience = {
      ...fynArts,
      title: "Hermanus Whale Festival",
      sessions: [{ start: "2027-10-01", precision: "month" }],
    };
    const september = stored({
      title: "Hermanus Whale Festival",
      firstDate: "2027-09-01",
      lastDate: "2027-09-30",
      onlyMonthOrYear: true,
    });
    assert.equal(matchInCode(october, { start: "2027-10-01", end: "2027-10-31" }, [september]), september);
    assert.match(matchText(october, { start: "2027-10-01", end: "2027-10-31" }, []), /Dates: 2027-10-01 to 2027-10-31 \(only the month or year is known\)/);
  });

  test("the question shows each side's start time and marks what the listing already links to", () => {
    // Row 95: live listings beside experiences built from captures, as the rebuilt database has them.
    const pairs = [
      {
        extracted: { title: "Ladies Night: Focker In-Law", venue: "Whale Coast Mall", day: "2026-11-26" },
        stored: { title: "Focker In-Law Premiere Night", venue: "Road House Cinema", day: "2026-11-26" },
      },
      {
        extracted: { title: "Solstice Secret Sunrise", venue: "Grotto Beach", day: "2026-12-21" },
        stored: { title: "Solstice Secret Sunset", venue: "Grotto Beach", day: "2026-12-21" },
      },
    ];
    for (const { extracted, stored: known } of pairs) {
      const listing: ExtractedExperience = {
        ...fynArts,
        title: extracted.title,
        sessions: [{ start: extracted.day, precision: "day", startTime: "18:30" }],
        venue: { name: extracted.venue, city: "Hermanus" },
      };
      const candidate = stored({
        id: "known",
        title: known.title,
        venueName: known.venue,
        firstDate: known.day,
        lastDate: known.day,
        sessions: [{ startDate: known.day, endDate: known.day, startTime: "18:30" }],
      });
      const days = { start: extracted.day, end: extracted.day };
      assert.equal(matchInCode(listing, days, [candidate]), undefined);
      const text = matchText(listing, days, [candidate], new Set(["known"]));
      assert.match(text, new RegExp(`Dates: ${extracted.day} to ${extracted.day} at 18:30$`, "m"));
      assert.match(
        text,
        new RegExp(`- ID known: ${known.title}; venue: ${known.venue}, Hermanus; dates: ${known.day} to ${known.day} at 18:30; this listing already links to it$`, "m"),
      );
    }
    // No time is shown when none is known, and a few at most.
    assert.match(matchText(fynArts, span, []), /^Dates: 2027-06-12 to 2027-06-21$/m);
    const opera = stored({
      sessions: ["12:30:00", "18:00:00", "18:00", "20:00", "21:00"].map((startTime) => ({ startDate: "2027-02-01", endDate: "2027-02-01", startTime })),
    });
    assert.match(matchText(fynArts, span, [opera]), /dates: 2027-06-12 to 2027-06-21 at 12:30, 18:00, 20:00$/m);
    assert.match(MATCH_INSTRUCTIONS, /same place on the same day at the same start time/);
    assert.match(MATCH_INSTRUCTIONS, /a cinema inside a mall/);
  });

  test("a title naming only the kind of event is never matched in code to a particular one", () => {
    const parkrun: ExtractedExperience = {
      ...fynArts,
      title: "ParkRun",
      type: "recurring",
      sessions: [],
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-28" },
      venue: { name: "Hemel-en-Aarde and Benguela Cove", city: "Hermanus" },
    };
    const weekly = { firstDate: "2026-11-28", lastDate: null, recurrenceRule: "FREQ=WEEKLY;BYDAY=SA", type: "recurring" as const };
    const saturdays = { start: "2026-11-28", end: "2028-11-23" };
    for (const title of ["Hermanus parkrun", "Groeneweide Parkrun", "Benguela Cove parkrun"]) {
      assert.equal(matchInCode(parkrun, saturdays, [stored({ ...weekly, title })]), undefined);
    }
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
