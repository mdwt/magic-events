import { XMLParser } from "fast-xml-parser";
import rrule from "rrule";
import { z } from "zod";
import type { Location } from "../catalogue/ports.ts";
import { pageContent, visibleText } from "../shared/html.ts";
import type { LanguageModel } from "../shared/language-model.ts";
import type { Logger } from "../shared/logger.ts";
import { addMonths, dateIn, isIsoDate, lastDayOfMonth } from "./dates.ts";
import { EXTRACTION_INSTRUCTIONS } from "./instructions.ts";

// Extraction: one raw listing's content becomes zero or more extracted experiences. It does not classify, match
// or save. The three language model extractors share one implementation and differ only in how they prepare
// the content.

// ---- The extracted experience, in the shape docs/data-processing.md gives ----

export type ExtractedSession = {
  // A day, or the first day of the month or year for month or year precision.
  start: string;
  // The last day, for a session of several days in a row.
  end?: string;
  precision: "day" | "month" | "year";
  // Times need day precision.
  startTime?: string;
  endTime?: string;
  label?: string;
  soldOut?: boolean;
  cancelled?: boolean;
};

export type ExtractedRecurrence = {
  // An iCalendar recurrence rule, such as FREQ=WEEKLY;BYDAY=SA
  rule: string;
  start: string;
  // Left out when open-ended.
  end?: string;
  startTime?: string;
  endTime?: string;
  skipped?: string[];
};

export type ExtractedExperience = {
  title: string;
  summary?: string;
  description?: string;
  type: "single" | "run" | "recurring";
  // Expected is never set from a listing, and Removed and Past are Catalogue's.
  status: "announced" | "confirmed" | "postponed" | "cancelled";
  booking: "none" | "not_yet" | "open" | "sold_out" | "closed";
  // One for a single, one per date for a run, only the extra dates for a recurring experience.
  sessions: ExtractedSession[];
  recurrence?: ExtractedRecurrence;
  openingHours?: string;
  venue?: { name?: string; address?: string; city?: string };
  price?: { min?: number; max?: number; currency?: string };
  // ISO timestamps.
  onSaleAt?: string;
  bookingClosesAt?: string;
  bookingUrl?: string;
  imageUrl?: string;
  // The experience's own page, if it has one.
  url?: string;
  // The source's own categories and labels, used by classification.
  hints: string[];
};

export interface ExtractInput {
  // The raw listing's content, as fetched. A PDF as base64.
  content: string;
  contentType: string;
  url?: string;
  // Resolves relative dates such as "this Saturday", and is where the sourcing horizon is counted from.
  fetchedAt: Date;
  // The time now. An experience that is over by then, or by the fetch time, is left out.
  now: Date;
  // The source's location, from the Catalogue service.
  location: Location;
}

export interface Extractor {
  readonly kind: string;
  extract(input: ExtractInput): Promise<ExtractedExperience[]>;
}

// The content cannot be read as its kind: a feed item that is not XML, a listing with no content.
export class UnreadableListing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableListing";
  }
}

// ---- The answer's shape, as the language model gives it ----

// Structured output allows few optional fields and few unions, so every text field is required and empty
// when the item does not give it. Only the recurrence and the prices can be null.
const answerSessionSchema = z.object({
  start: z.string().describe("YYYY-MM-DD. For month or year precision, the first day of the month or year."),
  end: z.string().describe("The last day, YYYY-MM-DD, for several days in a row. Empty for a single day."),
  precision: z.enum(["day", "month", "year"]),
  startTime: z.string().describe("HH:MM local time, or empty. Only with day precision."),
  endTime: z.string().describe("HH:MM local time, or empty. Only with day precision."),
  label: z.string().describe("The source's name for this date, such as 'Opening night', or empty."),
  soldOut: z.boolean(),
  cancelled: z.boolean(),
});

const answerExperienceSchema = z.object({
  title: z.string(),
  summary: z.string(),
  description: z.string(),
  type: z.enum(["single", "run", "recurring"]),
  status: z.enum(["announced", "confirmed", "postponed", "cancelled"]),
  booking: z.enum(["none", "not_yet", "open", "sold_out", "closed"]),
  sessions: z.array(answerSessionSchema),
  recurrence: z
    .object({
      rule: z.string().describe("An iCalendar recurrence rule, such as FREQ=WEEKLY;BYDAY=SA"),
      start: z.string().describe("YYYY-MM-DD"),
      end: z.string().describe("YYYY-MM-DD, or empty when open-ended."),
      startTime: z.string(),
      endTime: z.string(),
      skipped: z.array(z.string()).describe("YYYY-MM-DD dates the rule gives on which it is not on."),
    })
    .nullable()
    .describe("Only for a recurring experience; null otherwise."),
  openingHours: z.string(),
  venueName: z.string(),
  venueAddress: z.string(),
  city: z.string(),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  currency: z.string().describe("ISO 4217, such as ZAR, or empty."),
  onSaleAt: z.string(),
  bookingClosesAt: z.string(),
  bookingUrl: z.string(),
  imageUrl: z.string(),
  url: z.string(),
  hints: z.array(z.string()),
});

export const extractionAnswerSchema = z.object({ experiences: z.array(answerExperienceSchema) });
export type ExtractionAnswer = z.infer<typeof extractionAnswerSchema>;
type AnswerExperience = z.infer<typeof answerExperienceSchema>;

function given(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// ---- What must hold whatever the model said ----

const TIME = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

// A time as HH:MM, null when it is not a time of day, undefined when none is given.
function settleTime(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const match = TIME.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// The start of a session as YYYY-MM-DD, accepting a month or a year written short for those precisions.
function settleStart(value: string, precision: ExtractedSession["precision"]): string | null {
  if (precision === "month" && /^\d{4}-\d{2}(-\d{2})?$/.test(value)) {
    const day = `${value.slice(0, 7)}-01`;
    return isIsoDate(day) ? day : null;
  }
  if (precision === "year" && /^\d{4}(-\d{2}-\d{2})?$/.test(value)) return `${value.slice(0, 4)}-01-01`;
  return isIsoDate(value) ? value : null;
}

function settleEnd(
  value: string | undefined,
  start: string,
  precision: ExtractedSession["precision"],
): { end: string | undefined } | { problem: string } {
  if (value === undefined) return { end: undefined };
  let end: string | null;
  if (precision === "month" && /^\d{4}-\d{2}(-\d{2})?$/.test(value) && isIsoDate(`${value.slice(0, 7)}-01`)) {
    end = lastDayOfMonth(value.slice(0, 7));
    if (end === lastDayOfMonth(start.slice(0, 7))) return { end: undefined };
  } else if (precision === "year" && /^\d{4}(-\d{2}-\d{2})?$/.test(value)) {
    end = `${value.slice(0, 4)}-12-31`;
    if (end.slice(0, 4) === start.slice(0, 4)) return { end: undefined };
  } else {
    end = isIsoDate(value) ? value : null;
    if (end === start) return { end: undefined };
  }
  if (end === null) return { problem: `the session end "${value}" is not a date` };
  if (end < start) return { problem: `a session ends (${end}) before it starts (${start})` };
  return { end };
}

// The last day a session covers.
export function sessionEnd(session: Pick<ExtractedSession, "start" | "end" | "precision">): string {
  if (session.end !== undefined) return session.end;
  if (session.precision === "month") return lastDayOfMonth(session.start.slice(0, 7));
  if (session.precision === "year") return `${session.start.slice(0, 4)}-12-31`;
  return session.start;
}

// The first and the last date of an experience. The last is null for an open-ended recurring experience.
export function experienceSpan(experience: ExtractedExperience): { first: string; last: string | null } {
  const starts = experience.sessions.map((session) => session.start);
  const ends = experience.sessions.map(sessionEnd);
  const recurrence = experience.recurrence;
  if (recurrence) starts.push(recurrence.start);
  const first = starts.reduce((a, b) => (b < a ? b : a));
  if (recurrence && recurrence.end === undefined) return { first, last: null };
  if (recurrence?.end !== undefined) ends.push(recurrence.end);
  return { first, last: ends.reduce((a, b) => (b > a ? b : a)) };
}

function settleTimestamp(value: string | undefined): string | undefined {
  // A date and a time, so a bare date is not read as midnight UTC.
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function settleUrl(value: string | undefined, base: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function settlePrice(value: number | null): number | undefined {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Booking must fit the status (docs/data-model.md, Experience status). Tickets on sale mean it is confirmed.
function settleBooking(
  status: ExtractedExperience["status"],
  booking: ExtractedExperience["booking"],
): Pick<ExtractedExperience, "status" | "booking"> {
  if (status === "postponed" || status === "cancelled") {
    return { status, booking: booking === "none" ? "none" : "closed" };
  }
  if ((booking === "open" || booking === "sold_out") && status === "announced") return { status: "confirmed", booking };
  return { status, booking };
}

// A rule Catalogue can generate sessions from. The library reads a rule with no FREQ as yearly, so FREQ is required.
function isValidRule(rule: string, start: string): boolean {
  if (!/(^|;)FREQ=/i.test(rule)) return false;
  try {
    rrule.rrulestr(`RRULE:${rule}`, { dtstart: new Date(`${start}T00:00:00Z`) });
    return true;
  } catch {
    return false;
  }
}

// One answered experience in the doc's shape, with everything that must hold checked. A problem that cannot be
// repaired drops this experience and says why.
export function settleExperience(
  answer: AnswerExperience,
  base: string | undefined,
): { experience: ExtractedExperience } | { problem: string } {
  const title = given(answer.title);
  if (title === undefined) return { problem: "it has no title" };

  const sessions: ExtractedSession[] = [];
  for (const raw of answer.sessions) {
    const start = settleStart(raw.start.trim(), raw.precision);
    if (start === null) return { problem: `the session start "${raw.start}" is not a date` };
    const end = settleEnd(given(raw.end), start, raw.precision);
    if ("problem" in end) return { problem: end.problem };
    const session: ExtractedSession = { start, precision: raw.precision };
    if (end.end !== undefined) session.end = end.end;
    // Times need day precision. A month or a year has none, so any given are dropped.
    if (raw.precision === "day") {
      const startTime = settleTime(given(raw.startTime));
      const endTime = settleTime(given(raw.endTime));
      if (startTime === null || endTime === null) return { problem: "a session time is not a time of day" };
      if (startTime !== undefined) session.startTime = startTime;
      if (endTime !== undefined) session.endTime = endTime;
    }
    const label = given(raw.label);
    if (label !== undefined) session.label = label;
    if (raw.soldOut) session.soldOut = true;
    if (raw.cancelled) session.cancelled = true;
    sessions.push(session);
  }

  let recurrence: ExtractedRecurrence | undefined;
  if (answer.recurrence !== null) {
    const raw = answer.recurrence;
    const rule = raw.rule.trim().replace(/^RRULE:/i, "");
    const start = raw.start.trim();
    if (!isIsoDate(start)) return { problem: `the recurrence start "${raw.start}" is not a date` };
    if (rule === "" || !isValidRule(rule, start)) return { problem: `"${raw.rule}" is not a recurrence rule` };
    recurrence = { rule, start };
    const end = given(raw.end);
    if (end !== undefined) {
      if (!isIsoDate(end)) return { problem: `the recurrence end "${end}" is not a date` };
      if (end < start) return { problem: "the recurrence ends before it starts" };
      recurrence.end = end;
    }
    const startTime = settleTime(given(raw.startTime));
    const endTime = settleTime(given(raw.endTime));
    if (startTime === null || endTime === null) return { problem: "a recurrence time is not a time of day" };
    if (startTime !== undefined) recurrence.startTime = startTime;
    if (endTime !== undefined) recurrence.endTime = endTime;
    const skipped = raw.skipped.map((day) => day.trim()).filter((day) => day !== "");
    if (skipped.some((day) => !isIsoDate(day))) return { problem: "a skipped date is not a date" };
    if (skipped.length > 0) recurrence.skipped = [...new Set(skipped)].sort();
  }

  switch (answer.type) {
    case "single":
      if (sessions.length !== 1) return { problem: `a single experience has ${sessions.length} sessions, not one` };
      break;
    case "run":
      if (sessions.length === 0) return { problem: "a run has no sessions" };
      break;
    case "recurring":
      if (recurrence === undefined) return { problem: "a recurring experience has no recurrence" };
      break;
  }
  if (answer.type !== "recurring" && recurrence !== undefined) {
    return { problem: `a ${answer.type} experience has a recurrence` };
  }

  const experience: ExtractedExperience = {
    title,
    type: answer.type,
    ...settleBooking(answer.status, answer.booking),
    sessions,
    hints: [...new Set(answer.hints.map((hint) => hint.trim()).filter((hint) => hint !== ""))],
  };
  if (recurrence !== undefined) experience.recurrence = recurrence;

  const summary = given(answer.summary);
  if (summary !== undefined) experience.summary = summary;
  const description = given(answer.description);
  if (description !== undefined) experience.description = description;
  const openingHours = given(answer.openingHours);
  if (openingHours !== undefined) experience.openingHours = openingHours;

  const venue = { name: given(answer.venueName), address: given(answer.venueAddress), city: given(answer.city) };
  if (venue.name !== undefined || venue.address !== undefined || venue.city !== undefined) {
    experience.venue = {};
    if (venue.name !== undefined) experience.venue.name = venue.name;
    if (venue.address !== undefined) experience.venue.address = venue.address;
    if (venue.city !== undefined) experience.venue.city = venue.city;
  }

  const min = settlePrice(answer.priceMin);
  const max = settlePrice(answer.priceMax);
  const currency = given(answer.currency)?.toUpperCase();
  if (min !== undefined || max !== undefined) {
    experience.price = {};
    if (min !== undefined) experience.price.min = min;
    if (max !== undefined) experience.price.max = max;
    if (currency !== undefined && /^[A-Z]{3}$/.test(currency)) experience.price.currency = currency;
  }

  const onSaleAt = settleTimestamp(given(answer.onSaleAt));
  if (onSaleAt !== undefined) experience.onSaleAt = onSaleAt;
  const bookingClosesAt = settleTimestamp(given(answer.bookingClosesAt));
  if (bookingClosesAt !== undefined) experience.bookingClosesAt = bookingClosesAt;
  const bookingUrl = settleUrl(given(answer.bookingUrl), base);
  if (bookingUrl !== undefined) experience.bookingUrl = bookingUrl;
  const imageUrl = settleUrl(given(answer.imageUrl), base);
  if (imageUrl !== undefined) experience.imageUrl = imageUrl;
  const url = settleUrl(given(answer.url), base);
  if (url !== undefined) experience.url = url;

  return { experience };
}

// The window an experience must fall in: not over by the later of the fetch day and today, and starting no later
// than the horizon counted from the fetch day. Days are the location's.
export function sourcingWindow(input: { fetchedAt: Date; now: Date; timezone: string; horizonMonths: number }): {
  overBefore: string;
  fetchDay: string;
  horizonEnd: string;
} {
  const fetchDay = dateIn(input.fetchedAt, input.timezone);
  const today = dateIn(input.now, input.timezone);
  return {
    overBefore: today > fetchDay ? today : fetchDay,
    fetchDay,
    horizonEnd: addMonths(fetchDay, input.horizonMonths),
  };
}

// ---- Preparing the content of each kind ----

interface Prepared {
  text: string;
  document?: { mediaType: string; base64: string };
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The text of an XML node, whether it was parsed as text, as a number, or as an element with attributes.
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value)) return textOf(value["#text"]) ?? (typeof value["@href"] === "string" ? value["@href"] : undefined);
  return undefined;
}

function textsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  return list.map(textOf).filter((text): text is string => text !== undefined);
}

// The one post of a feed: the item itself, or the first item of a feed that holds it.
function feedItem(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  const first = (value: unknown) => (Array.isArray(value) ? (value as unknown[])[0] : value);
  for (const candidate of [
    parsed.item,
    parsed.entry,
    isRecord(parsed.rss) && isRecord(parsed.rss.channel) ? parsed.rss.channel.item : undefined,
    isRecord(parsed.feed) ? parsed.feed.entry : undefined,
  ]) {
    const item = first(candidate);
    if (isRecord(item)) return item;
  }
  return undefined;
}

function prepareFeedItem(content: string): Prepared {
  let parsed: unknown;
  try {
    parsed = xml.parse(content);
  } catch (error) {
    throw new UnreadableListing(`The feed item is not XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const item = feedItem(parsed);
  if (item === undefined) throw new UnreadableListing("The feed item has no <item> or <entry>.");

  const body = textOf(item["content:encoded"]) ?? textOf(item.content) ?? textOf(item.description) ?? "";
  const lines = [
    `Title: ${textOf(item.title) ?? ""}`,
    `Link: ${textOf(item.link) ?? ""}`,
    `Published: ${textOf(item.pubDate) ?? textOf(item.published) ?? textOf(item.updated) ?? ""}`,
  ];
  const categories = textsOf(item.category);
  if (categories.length > 0) lines.push(`Categories: ${categories.join(", ")}`);
  // The body is HTML in most feeds; its visible text is what the post says.
  lines.push("", /<[a-z][\s\S]*>/i.test(body) ? visibleText(body) : body.trim());
  return { text: lines.join("\n") };
}

const PREPARE: Record<string, (content: string) => Prepared> = {
  rss_feed: prepareFeedItem,
  web_page: (content) => ({ text: pageContent(content) }),
  pdf_calendar: (content) => ({
    text: "The content is the attached PDF calendar.",
    document: { mediaType: "application/pdf", base64: content },
  }),
};

const KIND_NAMES: Record<string, string> = {
  rss_feed: "a post from a news feed",
  web_page: "a web page",
  pdf_calendar: "a PDF calendar",
};

function weekdayAndDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

// The request text: the context first, then the content.
export function extractionText(input: ExtractInput, kind: string, horizonEnd: string, prepared: Prepared): string {
  const { location } = input;
  return [
    `Place: ${location.name}, ${location.region}, ${location.country}. Its timezone is ${location.timezone}.`,
    `Fetched: ${input.fetchedAt.toISOString()}, which is ${weekdayAndDate(input.fetchedAt, location.timezone)} ` +
      `in ${location.name}.`,
    `Sourcing horizon: leave out anything that starts after ${horizonEnd}.`,
    `The item is ${KIND_NAMES[kind] ?? kind}${input.url === undefined ? "" : `, at ${input.url}`}.`,
    "",
    "Content:",
    prepared.text,
  ].join("\n");
}

class LanguageModelExtractor implements Extractor {
  readonly kind: string;
  readonly #prepare: (content: string) => Prepared;
  readonly #languageModel: LanguageModel;
  readonly #horizonMonths: number;
  readonly #logger: Logger;

  constructor(deps: {
    kind: string;
    prepare: (content: string) => Prepared;
    languageModel: LanguageModel;
    horizonMonths: number;
    logger: Logger;
  }) {
    this.kind = deps.kind;
    this.#prepare = deps.prepare;
    this.#languageModel = deps.languageModel;
    this.#horizonMonths = deps.horizonMonths;
    this.#logger = deps.logger;
  }

  async extract(input: ExtractInput): Promise<ExtractedExperience[]> {
    const prepared = this.#prepare(input.content);
    const bounds = sourcingWindow({
      fetchedAt: input.fetchedAt,
      now: input.now,
      timezone: input.location.timezone,
      horizonMonths: this.#horizonMonths,
    });
    const answer = await this.#languageModel.ask({
      instructions: EXTRACTION_INSTRUCTIONS,
      text: extractionText(input, this.kind, bounds.horizonEnd, prepared),
      ...(prepared.document ? { document: prepared.document } : {}),
      schema: extractionAnswerSchema,
    });

    const kept: ExtractedExperience[] = [];
    for (const answered of answer.experiences) {
      const settled = settleExperience(answered, input.url);
      if ("problem" in settled) {
        this.#logger.warn({ title: answered.title, problem: settled.problem }, "Extracted experience dropped");
        continue;
      }
      const span = experienceSpan(settled.experience);
      if (span.last !== null && span.last < bounds.overBefore) {
        this.#logger.debug({ title: answered.title, last: span.last }, "Extracted experience is already over");
        continue;
      }
      if (span.first > bounds.horizonEnd) {
        this.#logger.debug({ title: answered.title, first: span.first }, "Extracted experience is beyond the horizon");
        continue;
      }
      kept.push(settled.experience);
    }
    // An item that lists several experiences is the own page of none of them.
    const itemUrl = settleUrl(input.url, undefined);
    if (kept.length > 1 && itemUrl !== undefined) {
      for (const experience of kept) if (experience.url === itemUrl) delete experience.url;
    }
    this.#logger.debug({ kind: this.kind, answered: answer.experiences.length, kept: kept.length }, "Extracted");
    return kept;
  }
}

// One extractor per source kind that has one. Quicket and Ticketmaster have none in this phase.
export function createExtractors(deps: {
  languageModel: LanguageModel;
  horizonMonths: number;
  logger: Logger;
}): Map<string, Extractor> {
  return new Map(
    Object.entries(PREPARE).map(([kind, prepare]) => [
      kind,
      new LanguageModelExtractor({ kind, prepare, ...deps }),
    ]),
  );
}
