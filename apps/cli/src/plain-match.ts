import { normaliseTitle, ONLY_MONTH_OR_YEAR } from "@magic-events/core/data-processing/match.ts";

// Matching without the model, when it is plain. The captures command answers the language model's match question
// with this before it asks the real model. Data processing asks only when no candidate has the same normalised
// title with dates that fit (matchInCode in packages/core), so whatever this says "sure" to is looser than that.

// Words that say nothing about which experience a title names.
const WEAK_WORDS = new Set(
  ("hermanus live at in the and of with presents present show concert by on for to a an die en se van op by n " +
    "tribute experience event events").split(" "),
);

// Words of a date, which a title may carry or leave out, such as "11 Dec 2026".
const DATE_WORDS = new Set(
  ("jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october " +
    "nov november dec december mon monday tue tuesday wed wednesday thu thursday fri friday sat saturday sun sunday")
    .split(" "),
);

// A title's words that name something, each with a plural "s" taken off, so "Years" and "Year" are one word.
export function strongWords(value: string): Set<string> {
  return new Set(
    normaliseTitle(value)
      .split(" ")
      .filter((word) => word.length > 1 && !WEAK_WORDS.has(word) && !/^\d+$/.test(word))
      .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)),
  );
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

export interface MatchQuestion {
  title: string;
  place: string;
  start: string;
  recurring: boolean;
  // True when its dates are known only to the month or year.
  monthOrYear: boolean;
  candidates: { id: string; title: string; place: string; first: string; recurring: boolean; monthOrYear: boolean }[];
}

const COARSE = ONLY_MONTH_OR_YEAR.replace(/[()]/g, "\\$&");

// The question as Data processing writes it (matchText in match.ts), read back.
export function readMatchQuestion(question: string): MatchQuestion | undefined {
  const title = /^Title: (.*)$/m.exec(question)?.[1];
  const place = /^Venue: (.*)$/m.exec(question)?.[1];
  const dates = new RegExp(`^Dates: (\\S+) to (\\S+?)(${COARSE})?(, repeating .*)?$`, "m").exec(question);
  if (title === undefined || place === undefined || !dates) return undefined;
  const line = new RegExp(`^- ID (\\S+): (.*); venue: (.*); dates: (\\S+) to (\\S+?)(${COARSE})?(, repeating .*)?$`, "gm");
  const candidates = [...question.matchAll(line)].map((found) => ({
    id: found[1] ?? "",
    title: found[2] ?? "",
    place: found[3] ?? "",
    first: found[4] ?? "",
    monthOrYear: found[6] !== undefined,
    recurring: found[7] !== undefined,
  }));
  return {
    title,
    place,
    start: dates[1] ?? "",
    monthOrYear: dates[3] !== undefined,
    recurring: dates[4] !== undefined,
    candidates,
  };
}

export type PlainVerdict = { verdict: "sure"; id: string } | { verdict: "unsure" | "none" };

// The words of one title that the other does not have, leaving out the words of either venue and of dates: what
// one title names and the other does not.
function ownWords(words: Set<string>, others: Set<string>, places: Set<string>): string[] {
  return [...words].filter((word) => !others.has(word) && !places.has(word) && !DATE_WORDS.has(word));
}

// "sure" with the candidate it is, "unsure" when a candidate might be it, "none" when no candidate comes close.
// When it is not sure it never merges: a second copy of an experience is easier to mend than two made one.
//
// Sure is looser than the same normalised title, so it is kept to what is safe. Once the words of the venues and
// of dates are set aside:
//   - the two titles have the same words, at the same place or with no place to tell them apart; or
//   - one title only adds to the other, such as a performer or a tour's name, and they are one dated experience at
//     the same place starting the same day.
// When each title has words of its own, they may name different organisers, operators or venues, such as
// "Hermanus Whale Cruises boat-based whale watching" and "Boat-based whale watching with Southern Right Charters",
// so it is never sure. Nor is it for a recurring experience that only one title adds to, since two operators can
// run the same trip every day from the same harbour, or that shares only one word, since "ParkRun" names no
// particular parkrun. And when one side's dates are known only to the month or year and the other's to the day, the
// titles must have the same words: a series such as "Sunset Sessions" in December is not one act's dated concert
// in it, such as "Jeremy Loops Live at Stanford Hills Sunset Sessions".
export function matchPlainly(question: MatchQuestion): PlainVerdict {
  const words = strongWords(question.title);
  const place = strongWords(question.place);
  let best: { id: string; shared: number } | undefined;
  let unsure = false;
  for (const candidate of question.candidates) {
    const theirs = strongWords(candidate.title);
    const smaller = Math.min(words.size, theirs.size);
    if (smaller === 0) continue;
    const shared = sharedCount(words, theirs);
    const cover = shared / smaller;
    const theirPlace = strongWords(candidate.place);
    const samePlace = sharedCount(place, theirPlace) > 0;
    const placesDiffer = place.size > 0 && theirPlace.size > 0 && !samePlace;
    const sameKind = question.recurring === candidate.recurring;
    const sameStart = question.start === candidate.first;

    const places = new Set([...place, ...theirPlace]);
    const ours = ownWords(words, theirs, places);
    const others = ownWords(theirs, words, places);
    const sameWords = ours.length === 0 && others.length === 0;
    const oneAdds = (ours.length === 0) !== (others.length === 0);
    const samePrecision = question.monthOrYear === candidate.monthOrYear;
    const sure =
      sameKind &&
      !placesDiffer &&
      shared >= (question.recurring ? 2 : 1) &&
      ((sameWords && (shared >= 2 || (sameStart && samePlace))) ||
        (oneAdds && samePrecision && !question.recurring && sameStart && samePlace));
    // What might be the same, and is not sure, is unsure: the model is asked, or with the model off it stays two.
    const close =
      (sameKind && !placesDiffer && cover >= 0.8 && shared >= 2) ||
      (shared >= 1 && cover >= 0.5 && (sameStart || (question.recurring && candidate.recurring)));
    if (sure) {
      if (!best || shared > best.shared) best = { id: candidate.id, shared };
    } else if (close) {
      unsure = true;
    }
  }
  if (best) return { verdict: "sure", id: best.id };
  return { verdict: unsure ? "unsure" : "none" };
}
