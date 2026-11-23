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
  // A day, or for a recurring experience the first day of its rule.
  start: string;
  rule?: string;
}

function verdict(extracted: Side, stored: Side): string {
  const experience: ExtractedExperience = {
    title: extracted.title,
    type: extracted.rule ? "recurring" : "single",
    status: "confirmed",
    booking: "none",
    sessions: extracted.rule ? [] : [{ start: extracted.start, precision: "day" }],
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
    lastDate: stored.rule ? null : stored.start,
    sessions: [],
    onlyMonthOrYear: false,
    recurrenceRule: stored.rule ?? null,
    listingIds: [],
  };
  const span = { start: extracted.start, end: extracted.rule ? "2028-11-23" : extracted.start };
  const question = readMatchQuestion(matchText(experience, span, [candidate]));
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
});
