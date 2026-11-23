import { z } from "zod";
import type { ExperienceMatch } from "../catalogue/ports.ts";
import { overlaps } from "./dates.ts";
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

// The same title once normalised, with overlapping dates, is the same experience. No model is asked.
export function matchInCode(
  experience: ExtractedExperience,
  span: Span,
  candidates: ExperienceMatch[],
): ExperienceMatch | undefined {
  const title = normaliseTitle(experience.title);
  return candidates.find((candidate) => normaliseTitle(candidate.title) === title && datesOverlap(span, candidate));
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

export function matchText(experience: ExtractedExperience, span: Span, candidates: ExperienceMatch[]): string {
  const venue = [experience.venue?.name, experience.venue?.city].filter((part) => part !== undefined).join(", ");
  const lines = [
    "The experience a source describes:",
    `Title: ${experience.title}`,
    `Summary: ${experience.summary ?? ""}`,
    `Venue: ${venue}`,
    `Dates: ${span.start} to ${span.end}${experience.recurrence ? `, repeating ${experience.recurrence.rule}` : ""}`,
    "",
    "The known experiences:",
  ];
  for (const candidate of candidates) {
    const place = [candidate.venueName, candidate.city].filter((part) => part !== null).join(", ");
    lines.push(
      `- ID ${candidate.id}: ${candidate.title}; venue: ${place}; dates: ${candidate.firstDate ?? "?"} to ` +
        `${candidate.lastDate ?? "open-ended"}${candidate.recurrenceRule ? `, repeating ${candidate.recurrenceRule}` : ""}`,
    );
  }
  return lines.join("\n");
}

// The model's pick, which counts only when it is one of the candidates.
export function pickedCandidate(answer: MatchAnswer, candidates: ExperienceMatch[]): ExperienceMatch | undefined {
  const id = answer.experienceId.trim();
  return id === "" ? undefined : candidates.find((candidate) => candidate.id === id);
}

// How this listing's values meet the stored ones: it leads when its source's priority is the highest among the
// listings the experience is linked to, ties included, and otherwise only fills what is empty.
export function precedenceOf(
  ownPriority: number,
  ownListingId: string,
  priorities: Record<string, number>,
): "lead" | "fill" {
  const others = Object.entries(priorities)
    .filter(([listingId]) => listingId !== ownListingId)
    .map(([, priority]) => priority);
  return others.every((priority) => ownPriority >= priority) ? "lead" : "fill";
}
