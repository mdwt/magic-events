import { z } from "zod";
import type { ExperienceMatch } from "../catalogue/ports.ts";
import { addMonths, overlaps } from "./dates.ts";
import type { ExtractedExperience } from "./extract.ts";

// Matching: whether an extracted experience is one Catalogue already has. Catalogue supplies the source links and
// the candidates; the decision is made here.

// Final statuses: nothing changes such an experience any more, so it is not matched by a new listing.
const FINAL = new Set(["cancelled", "removed", "past"]);

export function isFinal(match: ExperienceMatch): boolean {
  return FINAL.has(match.status);
}

const LEADING_ARTICLE = /^(the|a|an|die|n)\s+/;

// A title with case, accents, punctuation, years and a leading article taken out, so that
// "The Hermanus FynArts Festival 2027" and "Hermanus Fynarts festival" are the same.
export function normaliseTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(LEADING_ARTICLE, "")
    .replace(/\s+/g, " ");
}

// The extracted experience's dates as one span: its first date to its last, or to the horizon when open-ended.
export interface Span {
  start: string;
  end: string;
}

function datesOverlap(span: Span, match: ExperienceMatch): boolean {
  if (match.firstDate === null) return false;
  return overlaps(span, { start: match.firstDate, end: match.lastDate ?? span.end });
}

// True when the extracted experience's dates are known only to the month or year: it has sessions, every one of
// month or year precision, and no recurrence.
export function onlyMonthOrYear(experience: ExtractedExperience): boolean {
  return (
    experience.recurrence === undefined &&
    experience.sessions.length > 0 &&
    experience.sessions.every((session) => session.precision !== "day")
  );
}

// How many months either side of a year boundary dates may be and still be near.
const NEAR_MONTHS = 3;

// The dates near a span, for dates known only to the month or year: the whole of every year the span touches,
// and a few months either side of it, so September and October 2027 are near, and December 2027 and January 2028
// too, but two yearly editions are not.
export function nearDates(span: Span): Span {
  const yearStart = `${span.start.slice(0, 4)}-01-01`;
  const yearEnd = `${span.end.slice(0, 4)}-12-31`;
  const before = addMonths(span.start, -NEAR_MONTHS);
  const after = addMonths(span.end, NEAR_MONTHS);
  return { start: before < yearStart ? before : yearStart, end: after > yearEnd ? after : yearEnd };
}

// Whether a candidate's dates fit the extracted experience's. They must overlap, unless the dates on either side
// are known only to the month or year: then they need only be near, since two sources often give such an
// experience different months. Dates of day precision on both sides must overlap, so two editions of a weekly or
// yearly experience on different days stay two experiences.
export function datesFit(experience: ExtractedExperience, span: Span, candidate: ExperienceMatch): boolean {
  if (datesOverlap(span, candidate)) return true;
  if (!onlyMonthOrYear(experience) && !candidate.onlyMonthOrYear) return false;
  return datesOverlap(nearDates(span), candidate);
}

// The same title once normalised, with dates that fit, is the same experience. No model is asked.
export function matchInCode(
  experience: ExtractedExperience,
  span: Span,
  candidates: ExperienceMatch[],
): ExperienceMatch | undefined {
  const title = normaliseTitle(experience.title);
  return candidates.find(
    (candidate) => normaliseTitle(candidate.title) === title && datesFit(experience, span, candidate),
  );
}

// Among the experiences the listing already links to, the one with the same title. Their dates may have moved,
// since this listing is the one that moves them, so only the title is compared.
export function matchLinked(
  experience: ExtractedExperience,
  linked: ExperienceMatch[],
): ExperienceMatch | undefined {
  const title = normaliseTitle(experience.title);
  return linked.find((match) => normaliseTitle(match.title) === title);
}

export const matchAnswerSchema = z.object({
  experienceId: z.string().describe("The ID of the known experience it is, exactly as given, or empty for none."),
});
export type MatchAnswer = z.infer<typeof matchAnswerSchema>;

// Said after dates known only to the month or year, so the model, and the captures command reading the question
// back, can tell a series or an announced month from a dated event.
export const ONLY_MONTH_OR_YEAR = " (only the month or year is known)";

export function matchText(experience: ExtractedExperience, span: Span, candidates: ExperienceMatch[]): string {
  const venue = [experience.venue?.name, experience.venue?.city].filter((part) => part !== undefined).join(", ");
  const coarse = onlyMonthOrYear(experience) ? ONLY_MONTH_OR_YEAR : "";
  const lines = [
    "The experience a source describes:",
    `Title: ${experience.title}`,
    `Summary: ${experience.summary ?? ""}`,
    `Venue: ${venue}`,
    `Dates: ${span.start} to ${span.end}${coarse}${experience.recurrence ? `, repeating ${experience.recurrence.rule}` : ""}`,
    "",
    "The known experiences:",
  ];
  for (const candidate of candidates) {
    const place = [candidate.venueName, candidate.city].filter((part) => part !== null).join(", ");
    lines.push(
      `- ID ${candidate.id}: ${candidate.title}; venue: ${place}; dates: ${candidate.firstDate ?? "?"} to ` +
        `${candidate.lastDate ?? "open-ended"}${candidate.onlyMonthOrYear ? ONLY_MONTH_OR_YEAR : ""}` +
        (candidate.recurrenceRule ? `, repeating ${candidate.recurrenceRule}` : ""),
    );
  }
  return lines.join("\n");
}

// The model's pick, which counts only when it is one of the candidates.
export function pickedCandidate(answer: MatchAnswer, candidates: ExperienceMatch[]): ExperienceMatch | undefined {
  const id = answer.experienceId.trim();
  return id === "" ? undefined : candidates.find((candidate) => candidate.id === id);
}

// How this listing's values meet the stored ones: it leads when its source's priority is higher than every other
// linked listing's, or when it shares the highest and was linked before the others that do. A listing not linked
// yet comes after every linked one, so a new source of the same priority only fills, and two sources of the same
// priority do not take the lead from each other each time one is processed. Otherwise it only fills what is
// empty. `linked` is the experience's listings in the order they were linked, the oldest first.
export function precedenceOf(
  own: { listingId: string; priority: number },
  linked: { listingId: string; priority: number }[],
): "lead" | "fill" {
  const others = linked.filter((one) => one.listingId !== own.listingId);
  if (others.some((one) => one.priority > own.priority)) return "fill";
  const ownPlace = linked.findIndex((one) => one.listingId === own.listingId);
  const tiedBefore = others.some(
    (one) => one.priority === own.priority && (ownPlace === -1 || linked.indexOf(one) < ownPlace),
  );
  return tiedBefore ? "fill" : "lead";
}
