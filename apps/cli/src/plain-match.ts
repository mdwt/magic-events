import { normaliseTitle } from "@magic-events/core/data-processing/match.ts";

// Matching without the model, when it is plain. The captures command answers the language model's match question
// with this before it asks the real model. Data processing asks only when no candidate has the same normalised
// title with dates that fit (matchInCode in packages/core), so whatever this says "sure" to is looser than that.

// Words that say nothing about which experience a title names.
const WEAK_WORDS = new Set(
  ("hermanus live at in the and of with presents present show concert by on for to a an die en se van op by n " +
    "tribute experience event events").split(" "),
);

export function strongWords(value: string): Set<string> {
  return new Set(
    normaliseTitle(value)
      .split(" ")
      .filter((word) => word.length > 1 && !WEAK_WORDS.has(word) && !/^\d+$/.test(word)),
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
  candidates: { id: string; title: string; place: string; first: string; recurring: boolean }[];
}

// The question as Data processing writes it (matchText in match.ts), read back.
export function readMatchQuestion(question: string): MatchQuestion | undefined {
  const title = /^Title: (.*)$/m.exec(question)?.[1];
  const place = /^Venue: (.*)$/m.exec(question)?.[1];
  const dates = /^Dates: (\S+) to (\S+?)(, repeating .*)?$/m.exec(question);
  if (title === undefined || place === undefined || !dates) return undefined;
  const candidates = [...question.matchAll(/^- ID (\S+): (.*); venue: (.*); dates: (\S+) to (\S+?)(, repeating .*)?$/gm)].map(
    (found) => ({
      id: found[1] ?? "",
      title: found[2] ?? "",
      place: found[3] ?? "",
      first: found[4] ?? "",
      recurring: found[6] !== undefined,
    }),
  );
  return { title, place, start: dates[1] ?? "", recurring: dates[3] !== undefined, candidates };
}

export type PlainVerdict = { verdict: "sure"; id: string } | { verdict: "unsure" | "none" };

// "sure" with the candidate it is, "unsure" when a candidate might be it, "none" when no candidate comes close.
// When it is not sure it never merges: a second copy of an experience is easier to mend than two made one.
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

    const sure =
      sameKind && !placesDiffer && ((cover >= 0.8 && shared >= 2) || (cover === 1 && sameStart && samePlace));
    if (sure) {
      if (!best || shared > best.shared) best = { id: candidate.id, shared };
    } else if (shared >= 1 && cover >= 0.5 && (sameStart || (question.recurring && candidate.recurring))) {
      unsure = true;
    }
  }
  if (best) return { verdict: "sure", id: best.id };
  return { verdict: unsure ? "unsure" : "none" };
}
