import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExperienceMatch } from "@magic-events/core/catalogue/ports.ts";
import type { ExtractedExperience } from "@magic-events/core/data-processing/extract.ts";
import { matchText } from "@magic-events/core/data-processing/match.ts";
import { matchPlainly, readMatchQuestion } from "../src/plain-match.ts";

// The captures command's plain matcher, given the question exactly as Data processing writes it. The pairs are
// real ones from data/hermanus/extracted.

interface Side {
  title: string;
  venue: string;
  city: string;
  // A day, or for a recurring experience the first day of its rule, or the first day of a month.
  start: string;
  rule?: string;
  // Known only to the month that starts on `start`.
  month?: true;
  // The start time, as HH:MM.
  time?: string;
}

function lastDay(start: string): string {
  const [year, month] = start.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function verdict(extracted: Side, stored: Side): string {
  const experience: ExtractedExperience = {
    title: extracted.title,
    type: extracted.rule ? "recurring" : "single",
    status: "confirmed",
    booking: "none",
    sessions: extracted.rule
      ? []
      : [
          {
            start: extracted.start,
            precision: extracted.month ? "month" : "day",
            ...(extracted.time ? { startTime: extracted.time } : {}),
          },
        ],
    ...(extracted.rule ? { recurrence: { rule: extracted.rule, start: extracted.start } } : {}),
    venue: { name: extracted.venue, city: extracted.city },
    hints: [],
  };
  const candidate: ExperienceMatch = {
    id: "stored",
    title: stored.title,
    type: stored.rule ? "recurring" : "single",
    status: "confirmed",
    venueName: stored.venue,
    city: stored.city,
    firstDate: stored.start,
    lastDate: stored.rule ? null : stored.month ? lastDay(stored.start) : stored.start,
    sessions: [{ startDate: stored.start, endDate: stored.start, startTime: stored.time ?? null }],
    onlyMonthOrYear: stored.month === true,
    recurrenceRule: stored.rule ?? null,
    listingIds: [],
  };
  const end = extracted.rule ? "2028-11-23" : extracted.month ? lastDay(extracted.start) : extracted.start;
  const span = { start: extracted.start, end };
  // The candidate is marked as linked to the listing, so the question carries every part core can write.
  const question = readMatchQuestion(matchText(experience, span, [candidate], new Set(["stored"])));
  assert.equal(question?.candidates.length, 1, "the candidate could not be read back");
  assert.ok(question, "the question could not be read back");
  return matchPlainly(question).verdict;
}

const WHALE_SEASON = "FREQ=DAILY;BYMONTH=6,7,8,9,10,11";

describe("Plain matching", () => {
  test("two operators' trips from the same harbour are never matched plainly", () => {
    const whaleCruises = {
      title: "Hermanus Whale Cruises boat-based whale watching",
      venue: "New Harbour",
      city: "Hermanus",
      start: "2026-11-23",
      rule: WHALE_SEASON,
    };
    const southernRight = {
      title: "Boat-based whale watching with Southern Right Charters",
      venue: "The Whale Shack, New Harbour",
      city: "Hermanus",
      start: "2026-11-23",
      rule: WHALE_SEASON,
    };
    assert.equal(verdict(whaleCruises, southernRight), "unsure");
    assert.equal(verdict(southernRight, whaleCruises), "unsure");
    // A recurring experience that only one title adds an operator to is not sure either.
    assert.equal(verdict({ ...southernRight, title: "Boat-based whale watching" }, southernRight), "unsure");
  });

  test("one dated experience whose title only adds a performer or the venue is matched, on the same day and place", () => {
    const golfClub = { venue: "Hermanus Golf Club", city: "Hermanus", start: "2026-12-03" };
    assert.equal(
      verdict(
        { ...golfClub, title: "Jingle Bell Rock at Hermanus Golf Club" },
        { ...golfClub, title: "JINGLE BELL ROCK with The Family Band at Hermanus Golf Club" },
      ),
      "sure",
    );
    assert.equal(
      verdict(
        { ...golfClub, start: "2026-12-11", title: "Rumours of Fleetwood Mac at Hermanus Golf Club" },
        { ...golfClub, start: "2026-12-11", title: "Rumours of Fleetwood Mac Tribute at Hermanus Golf Club 11 Dec 2026" },
      ),
      "sure",
    );
    const stadium = { venue: "Attie Bishop Stadium", city: "Hermanus", start: "2026-12-15" };
    assert.equal(
      verdict(
        { ...stadium, title: "Hermanus Carols 2026 by Rotary Club of Hermanus and sponsored by Hermanus Harcourts" },
        { ...stadium, venue: "Attie Bishop Field", title: "Hermanus Carols 2026" },
      ),
      "sure",
    );
    assert.equal(
      verdict(
        { title: "RAAF", venue: "FOMO Fine Art", city: "Pringle Bay", start: "2026-12-12" },
        { title: "RAAF @ Pringle Bay, FoMo", venue: "FoMo Fine Art Gallery & Events", city: "Pringle Bay", start: "2026-12-12" },
      ),
      "sure",
    );
  });

  test("titles that each name something of their own are not sure, even on the same day and place", () => {
    const cinema = { venue: "Road House Cinema, Whale Coast Mall", city: "Hermanus", start: "2026-11-26" };
    assert.equal(
      verdict(
        { ...cinema, title: "Whale Coast Mall: Premiere Night! Focker In-Law" },
        { ...cinema, title: "Whale Coast Mall: Ladies Night! Focker In-Law" },
      ),
      "unsure",
    );
  });

  test("an added word on another day is not sure, and titles with nothing in common are none", () => {
    const landskein = { venue: "Amphitheatre at Landskein", city: "Stanford" };
    assert.equal(
      verdict(
        { ...landskein, title: "Carols by Candlelight", start: "2026-12-19" },
        { ...landskein, title: "Carols by Candlelight with the Overberg Choir", start: "2026-12-20" },
      ),
      "unsure",
    );
    assert.equal(
      verdict(
        { ...landskein, title: "Open Air Cinema - Love Actually", start: "2026-12-23" },
        { ...landskein, title: "Whale Coast Symphony Orchestra", start: "2026-12-23" },
      ),
      "none",
    );
  });

  test("the same words with a plural or the venue left out are matched", () => {
    const landskein = { venue: "Amphitheatre at Landskein", city: "Stanford", start: "2026-12-31" };
    assert.equal(
      verdict(
        { ...landskein, venue: "Landskein Wines - The Parlour", title: "New Year's Eve Family Day" },
        { ...landskein, title: "New Years´s Eve Family Day at Landskein" },
      ),
      "sure",
    );
  });

  test("a series known by its month never takes one act's dated concert in it, whichever comes first", () => {
    const sunsetSessions = { title: "Sunset Sessions", venue: "Stanford Hills Estate", city: "Stanford", start: "2026-12-01", month: true as const };
    for (const [title, day] of [
      ["Jeremy Loops Live at Stanford Hills Sunset Sessions", "2026-12-23"],
      ["Jesse Clegg and Ross Learmonth Live at Stanford Hills Sunset Sessions", "2026-12-30"],
      ["Matthew Mole at Stanford Hills Sunset Sessions", "2026-12-26"],
      ["Will Linley Live at Stanford Hills Sunset Sessions", "2026-12-28"],
      // A concert on the first of the month starts the same day as the month.
      ["Jeremy Loops Live at Stanford Hills Sunset Sessions", "2026-12-01"],
    ] as const) {
      const concert = { title, venue: "Stanford Hills Estate", city: "Stanford", start: day };
      assert.notEqual(verdict(concert, sunsetSessions), "sure", title);
      assert.notEqual(verdict(sunsetSessions, concert), "sure", title);
    }
  });

  test("a festival known by its month is matched to its dated listing only when the titles have the same words", () => {
    // The capture has Kalfiefees only for August 2027; the days and the shorter title here are made up.
    const august = { title: "Kalfiefees Hermanus Kunstefees 2027", venue: "", city: "Hermanus", start: "2027-08-01", month: true as const };
    assert.equal(verdict({ title: "Kalfiefees Kunstefees", venue: "", city: "Hermanus", start: "2027-08-12" }, august), "sure");
    assert.equal(
      verdict({ title: "Kalfiefees Kunstefees: Opening Night", venue: "", city: "Hermanus", start: "2027-08-12" }, august),
      "unsure",
    );
  });

  test("a title naming only the kind of event never matches a particular one plainly", () => {
    const saturdays = { start: "2026-11-28", rule: "FREQ=WEEKLY;BYDAY=SA" };
    const parkRun = { ...saturdays, title: "ParkRun", venue: "Hemel-en-Aarde and Benguela Cove", city: "Hermanus" };
    const hermanus = { ...saturdays, title: "Hermanus parkrun", venue: "Camphill Road, Hemel-en-Aarde", city: "Hermanus" };
    const groeneweide = { ...saturdays, title: "Groeneweide Parkrun", venue: "Groeneweide Farm", city: "Gansbaai" };
    assert.notEqual(verdict(parkRun, hermanus), "sure");
    assert.notEqual(verdict(hermanus, parkRun), "sure");
    assert.notEqual(verdict(parkRun, groeneweide), "sure");
    // The same parkrun named by two sources still is.
    assert.equal(
      verdict(
        { ...saturdays, title: "ParkRun Benguela Cove Hermanus", venue: "Benguela Cove", city: "Hermanus" },
        { ...saturdays, title: "Benguela Cove parkrun", venue: "Benguela Cove Lagoon Wine Estate", city: "Hermanus" },
      ),
      "sure",
    );
  });

  test("questions with start times and a linked mark are read back whole", () => {
    const question = readMatchQuestion(
      [
        "The experience a source describes:",
        "Title: Ladies Night: Focker In-Law",
        "Summary: ",
        "Venue: Whale Coast Mall, Hermanus",
        "Dates: 2026-11-26 to 2026-11-26 at 18:30",
        "",
        "The known experiences:",
        "- ID a: Focker In-Law Premiere Night; venue: Road House Cinema, Hermanus; dates: 2026-11-26 to 2026-11-26 at 18:30; this listing already links to it",
        "- ID b: Sunset Sessions; venue: Stanford Hills Estate, Stanford; dates: 2026-12-01 to 2026-12-31 (only the month or year is known)",
        "- ID c: Hermanus parkrun; venue: Forest Adventures, Hermanus; dates: 2026-11-28 to open-ended at 08:00, repeating FREQ=WEEKLY;BYDAY=SA; this listing already links to it",
        "- ID d: The Met Opera: Manon; venue: Road House Cinema, Hermanus; dates: 2027-02-01 to 2027-02-01 at 12:30, 18:00",
      ].join("\n"),
    );
    assert.ok(question);
    assert.equal(question.start, "2026-11-26");
    assert.deepEqual(
      question.candidates.map(({ id, title, first, recurring, monthOrYear }) => ({ id, title, first, recurring, monthOrYear })),
      [
        { id: "a", title: "Focker In-Law Premiere Night", first: "2026-11-26", recurring: false, monthOrYear: false },
        { id: "b", title: "Sunset Sessions", first: "2026-12-01", recurring: false, monthOrYear: true },
        { id: "c", title: "Hermanus parkrun", first: "2026-11-28", recurring: true, monthOrYear: false },
        { id: "d", title: "The Met Opera: Manon", first: "2027-02-01", recurring: false, monthOrYear: false },
      ],
    );
  });

  test("the same place, day and start time under another name is left to the model, never sure on the time", () => {
    // Row 95's live listings beside experiences built from captures: each is one event, which the model decides.
    assert.equal(
      verdict(
        { title: "Ladies Night: Focker In-Law", venue: "Whale Coast Mall", city: "Hermanus", start: "2026-11-26", time: "18:30" },
        { title: "Focker In-Law Premiere Night", venue: "Road House Cinema", city: "Hermanus", start: "2026-11-26", time: "18:30" },
      ),
      "unsure",
    );
    assert.equal(
      verdict(
        { title: "Solstice Secret Sunrise", venue: "Grotto Beach", city: "Hermanus", start: "2026-12-21", time: "18:30" },
        { title: "Solstice Secret Sunset", venue: "Grotto Beach", city: "Hermanus", start: "2026-12-21", time: "18:30" },
      ),
      "unsure",
    );
    // Two different films at the same cinema at the same time stay apart.
    const cinema = { venue: "Road House Cinema, Whale Coast Mall", city: "Hermanus", start: "2026-11-26", time: "18:30" };
    assert.notEqual(
      verdict({ ...cinema, title: "Whale Coast Mall: Ladies Night! Focker In-Law" }, { ...cinema, title: "Whale Coast Mall: Ladies Night! The Debut" }),
      "sure",
    );
    assert.equal(verdict({ ...cinema, title: "Focker In-Law" }, { ...cinema, title: "Wicked: For Good" }), "none");
  });
});
