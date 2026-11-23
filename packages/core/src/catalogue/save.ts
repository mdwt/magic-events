import { isDeepStrictEqual } from "node:util";
import { AppError, type ErrorDetail } from "../shared/errors.ts";
import type {
  AttributeValue,
  ChangeKind,
  ExperienceStatus,
  SaveExperienceInput,
  StoredExperience,
} from "./ports.ts";
import { endOfMonth, endOfYear, isDay, isValidRule, ruleDays, startOfMonth, startOfYear } from "./recurrence.ts";

// The pure rules of saving an experience: reading the input, meeting the stored values, and working out what
// changed. The service loads, decides with these and hands the repository what to write.

export type StoredSession = StoredExperience["sessions"][number];
export type StoredRecurrence = NonNullable<StoredExperience["recurrence"]>;
type Booking = StoredExperience["booking"];

// An experience as it will be stored, before its generated sessions are worked out: `listed` holds the sessions
// a source gave, and `sessions` the generated ones that are kept.
export type Draft = StoredExperience & { listed: StoredSession[] };

// ---- Reading the input ----

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

// Times are stored as HH:MM:SS, as Postgres returns them, so a stored time and an incoming one compare equal.
function time(value: string | undefined, path: string, details: ErrorDetail[]): string | null {
  if (value === undefined) return null;
  const match = TIME_PATTERN.exec(value);
  if (match === null) {
    details.push({ path, message: `${path} must be a time as HH:MM.` });
    return null;
  }
  return `${match[1] ?? "00"}:${match[2] ?? "00"}:${match[3] ?? "00"}`;
}

function day(value: string, path: string, details: ErrorDetail[]): boolean {
  if (isDay(value)) return true;
  details.push({ path, message: `${path} must be a date as YYYY-MM-DD.` });
  return false;
}

function instant(value: string | undefined, path: string, details: ErrorDetail[]): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ path, message: `${path} must be an ISO timestamp.` });
    return null;
  }
  return parsed.toISOString();
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

// Numeric columns keep two decimals; rounding here keeps a stored price and an incoming one equal.
function money(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value * 100) / 100;
}

function listedSession(
  session: SaveExperienceInput["sessions"][number],
  path: string,
  details: ErrorDetail[],
): StoredSession | null {
  const startValid = day(session.startDate, `${path}.startDate`, details);
  const endValid = session.endDate === undefined || day(session.endDate, `${path}.endDate`, details);
  if (session.precision !== "day" && (session.startTime !== undefined || session.endTime !== undefined)) {
    details.push({ path, message: `${path} has a time, but times need day precision.` });
  }
  const startTime = time(session.startTime, `${path}.startTime`, details);
  const endTime = time(session.endTime, `${path}.endTime`, details);
  if (!startValid || !endValid) return null;
  if (session.endDate !== undefined && session.endDate < session.startDate) {
    details.push({ path: `${path}.endDate`, message: `${path} ends before it starts.` });
    return null;
  }

  const last = session.endDate ?? session.startDate;
  // A month or year session sits on the month's or year's boundaries.
  const [startDate, endDate] =
    session.precision === "month"
      ? [startOfMonth(session.startDate), endOfMonth(last)]
      : session.precision === "year"
        ? [startOfYear(session.startDate), endOfYear(last)]
        : [session.startDate, last];
  return {
    startDate,
    endDate,
    precision: session.precision,
    startTime: session.precision === "day" ? startTime : null,
    endTime: session.precision === "day" ? endTime : null,
    label: text(session.label),
    soldOut: session.soldOut ?? false,
    status: session.cancelled === true ? "cancelled" : "scheduled",
    origin: "listed",
  };
}

function recurrenceOf(
  recurrence: NonNullable<SaveExperienceInput["recurrence"]>,
  details: ErrorDetail[],
): StoredRecurrence | null {
  const rule = recurrence.rule.trim();
  const ruleValid = isValidRule(rule);
  if (!ruleValid) details.push({ path: "recurrence.rule", message: "recurrence.rule is not a recurrence rule we can use." });
  const startValid = day(recurrence.start, "recurrence.start", details);
  const endValid = recurrence.end === undefined || day(recurrence.end, "recurrence.end", details);
  if (startValid && endValid && recurrence.end !== undefined && recurrence.end < recurrence.start) {
    details.push({ path: "recurrence.end", message: "The recurrence ends before it starts." });
  }
  const skipped = (recurrence.skipped ?? []).filter((one, index) => day(one, `recurrence.skipped.${index}`, details));
  const startTime = time(recurrence.startTime, "recurrence.startTime", details);
  const endTime = time(recurrence.endTime, "recurrence.endTime", details);
  if (!ruleValid || !startValid || !endValid) return null;
  return {
    rule,
    start: recurrence.start,
    end: recurrence.end ?? null,
    startTime,
    endTime,
    skipped: [...new Set(skipped)].sort(),
  };
}

function sortedAttributes(attributes: Record<string, AttributeValue[]>): Record<string, AttributeValue[]> {
  const sorted: Record<string, AttributeValue[]> = {};
  for (const key of Object.keys(attributes).sort()) {
    const values = [...new Set(attributes[key] ?? [])].sort(compareValues);
    if (values.length > 0) sorted[key] = values;
  }
  return sorted;
}

function compareValues(a: AttributeValue, b: AttributeValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// The input read into the shape it is stored in. Refuses what cannot be stored, naming every problem.
export function readInput(input: SaveExperienceInput): Draft {
  const details: ErrorDetail[] = [];
  const title = text(input.title);
  if (title === null) details.push({ path: "title", message: "title must not be empty." });

  const listed = input.sessions
    .map((session, index) => listedSession(session, `sessions.${index}`, details))
    .filter((session) => session !== null);
  if (input.type === "single" && input.sessions.length > 1) {
    details.push({ path: "sessions", message: "A single experience has one session." });
  }

  let recurrence: StoredRecurrence | null = null;
  if (input.recurrence !== undefined && input.type !== "recurring") {
    details.push({ path: "recurrence", message: "Only a recurring experience has a recurrence." });
  } else if (input.recurrence === undefined && input.type === "recurring") {
    details.push({ path: "recurrence", message: "A recurring experience needs a recurrence." });
  } else if (input.recurrence !== undefined) {
    recurrence = recurrenceOf(input.recurrence, details);
  }

  const onSaleAt = instant(input.onSaleAt, "onSaleAt", details);
  const bookingClosesAt = instant(input.bookingClosesAt, "bookingClosesAt", details);

  if (details.length > 0 || title === null) {
    throw new AppError("invalid_input", details.map((detail) => detail.message).join(" "), details);
  }

  return {
    id: input.experienceId ?? "",
    version: 0,
    locationId: input.locationId,
    title,
    slug: "",
    summary: text(input.summary),
    description: text(input.description),
    profile: text(input.profile),
    type: input.type,
    status: input.status,
    booking: input.booking,
    timezone: "",
    openingHours: text(input.openingHours),
    venue: {
      name: text(input.venue?.name),
      address: text(input.venue?.address),
      city: text(input.venue?.city),
      position: input.venue?.position ?? null,
    },
    price: { min: money(input.price?.min), max: money(input.price?.max), currency: text(input.price?.currency) },
    onSaleAt,
    bookingClosesAt,
    bookingUrl: text(input.bookingUrl),
    imageUrl: text(input.imageUrl),
    pageUrl: text(input.pageUrl),
    recurrence,
    sessions: [],
    listed: sortSessions(listed),
    attributes: sortedAttributes(input.attributes),
    tags: [...new Set(input.tags)].sort(),
    listingIds: [input.source.listingId],
  };
}

// ---- Status and booking ----

export const FINAL_STATUSES: readonly ExperienceStatus[] = ["cancelled", "removed", "past"];

// The moves the status table in docs/data-model.md allows.
const MOVES: Record<ExperienceStatus, readonly ExperienceStatus[]> = {
  expected: ["announced", "confirmed", "cancelled", "removed", "past"],
  announced: ["confirmed", "postponed", "cancelled", "removed", "past"],
  confirmed: ["postponed", "cancelled", "removed", "past"],
  postponed: ["announced", "confirmed", "cancelled", "removed"],
  cancelled: [],
  removed: [],
  past: [],
};

export function canMove(from: ExperienceStatus, to: ExperienceStatus): boolean {
  return from === to || MOVES[from].includes(to);
}

// The booking the status allows, closest to the one asked for. None and Closed fit every status. An experience
// that is not going ahead on its dates has booking Closed. Open and Sold out need Confirmed: before that, an
// open booking is one that is not open yet, and a sold-out one has ended.
export function allowedBooking(status: ExperienceStatus, booking: Booking): Booking {
  if (booking === "none" || booking === "closed") return booking;
  if (status === "postponed" || FINAL_STATUSES.includes(status)) return "closed";
  if (booking === "not_yet" || status === "confirmed") return booking;
  return booking === "open" ? "not_yet" : "closed";
}

// ---- Meeting the stored values ----

function fill<T>(stored: T | null, incoming: T | null): T | null {
  return stored ?? incoming;
}

// The values the experience will have. "lead" takes the incoming values whole, so a field the input leaves out
// becomes empty. "fill" only fills what is empty, and takes the dates only when the experience has none.
// Status and booking are worked out by the caller.
export function meet(stored: StoredExperience, incoming: Draft, precedence: "lead" | "fill"): Draft {
  const generated = stored.sessions.filter((session) => session.origin === "generated");
  const storedListed = stored.sessions.filter((session) => session.origin === "listed");
  const listingIds = stored.listingIds.includes(incoming.listingIds[0] ?? "")
    ? stored.listingIds
    : [...stored.listingIds, ...incoming.listingIds];

  if (precedence === "lead") {
    return {
      ...incoming,
      id: stored.id,
      version: stored.version,
      locationId: stored.locationId,
      slug: stored.slug,
      timezone: stored.timezone,
      status: stored.status,
      booking: stored.booking,
      sessions: generated,
      listingIds,
    };
  }

  const takeDates = stored.sessions.length === 0 && stored.recurrence === null;
  const missingKeys = Object.keys(incoming.attributes).filter((key) => stored.attributes[key] === undefined);
  const priceEmpty = stored.price.min === null && stored.price.max === null && stored.price.currency === null;
  return {
    ...stored,
    summary: fill(stored.summary, incoming.summary),
    description: fill(stored.description, incoming.description),
    profile: fill(stored.profile, incoming.profile),
    openingHours: fill(stored.openingHours, incoming.openingHours),
    venue: {
      name: fill(stored.venue.name, incoming.venue.name),
      address: fill(stored.venue.address, incoming.venue.address),
      city: fill(stored.venue.city, incoming.venue.city),
      position: fill(stored.venue.position, incoming.venue.position),
    },
    price: priceEmpty ? incoming.price : stored.price,
    onSaleAt: fill(stored.onSaleAt, incoming.onSaleAt),
    bookingClosesAt: fill(stored.bookingClosesAt, incoming.bookingClosesAt),
    bookingUrl: fill(stored.bookingUrl, incoming.bookingUrl),
    imageUrl: fill(stored.imageUrl, incoming.imageUrl),
    pageUrl: fill(stored.pageUrl, incoming.pageUrl),
    // The type says how the dates are known, so it comes with them.
    type: takeDates ? incoming.type : stored.type,
    recurrence: takeDates ? incoming.recurrence : stored.recurrence,
    listed: takeDates ? incoming.listed : storedListed,
    sessions: takeDates ? [] : generated,
    attributes: sortedAttributes({
      ...stored.attributes,
      ...Object.fromEntries(missingKeys.map((key) => [key, incoming.attributes[key] ?? []])),
    }),
    tags: stored.tags.length === 0 ? incoming.tags : stored.tags,
    listingIds,
  };
}

// ---- Sessions ----

function compareSessions(a: StoredSession, b: StoredSession): number {
  return (
    a.startDate.localeCompare(b.startDate) ||
    (a.startTime ?? "").localeCompare(b.startTime ?? "") ||
    a.endDate.localeCompare(b.endDate) ||
    a.origin.localeCompare(b.origin) ||
    (a.label ?? "").localeCompare(b.label ?? "") ||
    a.status.localeCompare(b.status) ||
    Number(a.soldOut) - Number(b.soldOut)
  );
}

export function sortSessions(sessions: StoredSession[]): StoredSession[] {
  return [...sessions].sort(compareSessions);
}

export function sameSessions(a: StoredSession[], b: StoredSession[]): boolean {
  return isDeepStrictEqual(sortSessions(a), sortSessions(b));
}

// The sessions the recurrence gives from today, or from its first date when that is later, to its last date or
// the horizon. Skipped dates, dates a listed session covers and dates already kept are left out. Generated
// sessions before today are kept as they are; none are ever generated in the past.
export function generateSessions(args: {
  recurrence: StoredRecurrence | null;
  listed: StoredSession[];
  generated: StoredSession[];
  today: string;
  horizon: string;
}): StoredSession[] {
  const { recurrence, listed, today } = args;
  if (recurrence === null) return [];
  const kept = args.generated.filter((session) => session.startDate < today);
  const from = recurrence.start > today ? recurrence.start : today;
  const to = recurrence.end ?? args.horizon;
  const skipped = new Set(recurrence.skipped);
  const keptDays = new Set(kept.map((session) => session.startDate));
  const covered = (date: string) =>
    listed.some((session) => session.precision === "day" && session.startDate <= date && date <= session.endDate);

  const days = ruleDays(recurrence, from, to).filter((date) => !skipped.has(date) && !keptDays.has(date) && !covered(date));
  return [
    ...kept,
    ...days.map(
      (date): StoredSession => ({
        startDate: date,
        endDate: date,
        precision: "day",
        startTime: recurrence.startTime,
        endTime: recurrence.endTime,
        label: null,
        soldOut: false,
        status: "scheduled",
        origin: "generated",
      }),
    ),
  ];
}

// ---- What changed ----

// The fields whose change is a real change, and so a new version. The profile is left out: it is written again,
// in other words, on every processing. Generated sessions are left out: they follow from the recurrence.
export const TRACKED_FIELDS = [
  "title",
  "summary",
  "description",
  "type",
  "status",
  "booking",
  "openingHours",
  "venue",
  "price",
  "onSaleAt",
  "bookingClosesAt",
  "bookingUrl",
  "imageUrl",
  "pageUrl",
  "recurrence",
  "sessions",
  "attributes",
  "tags",
  "listingIds",
] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

function listedOf(experience: StoredExperience) {
  return sortSessions(experience.sessions.filter((session) => session.origin === "listed")).map((session) => ({
    startDate: session.startDate,
    endDate: session.endDate,
    precision: session.precision,
    startTime: session.startTime,
    endTime: session.endTime,
    label: session.label,
    soldOut: session.soldOut,
    status: session.status,
  }));
}

function trackedValue(experience: StoredExperience, field: TrackedField): unknown {
  switch (field) {
    case "sessions":
      return listedOf(experience);
    case "attributes":
      return sortedAttributes(experience.attributes);
    case "tags":
    case "listingIds":
      return [...experience[field]].sort();
    default:
      return experience[field];
  }
}

export function changedFields(before: StoredExperience, after: StoredExperience): TrackedField[] {
  return TRACKED_FIELDS.filter((field) => !isDeepStrictEqual(trackedValue(before, field), trackedValue(after, field)));
}

// The previous values of the fields that changed, for the change row. When the sessions or the recurrence changed,
// `sessions` holds every session it had, generated ones included, so changed-since can tell that it was on during
// a client's dates before the change.
export function previousValues(before: StoredExperience, fields: TrackedField[]): Record<string, unknown> {
  const previous: Record<string, unknown> = Object.fromEntries(
    fields.map((field) => [field, trackedValue(before, field)]),
  );
  if (fields.includes("sessions") || fields.includes("recurrence")) previous.sessions = sortSessions(before.sessions);
  return previous;
}

// A listed session was added, moved or removed, or the recurrence changed. A session that only became sold out,
// was cancelled or was relabelled has not moved.
function datesChanged(before: StoredExperience, after: StoredExperience): boolean {
  const dates = (experience: StoredExperience) =>
    listedOf(experience).map(({ startDate, endDate, precision, startTime, endTime }) =>
      [startDate, endDate, precision, startTime, endTime].join("|"),
    );
  return !isDeepStrictEqual(before.recurrence, after.recurrence) || !isDeepStrictEqual(dates(before), dates(after));
}

// The one kind a version is reported as: the first that applies of cancelled, removed, postponed, rescheduled,
// confirmed and changed (docs/data-model.md, "Reported by changed-since as").
export function changeKind(before: StoredExperience, after: StoredExperience): ChangeKind {
  const moved = before.status !== after.status;
  if (moved && after.status === "cancelled") return "cancelled";
  if (moved && after.status === "removed") return "removed";
  if (moved && after.status === "postponed") return "postponed";
  const outOfPostponed = before.status === "postponed" && (after.status === "announced" || after.status === "confirmed");
  if (datesChanged(before, after) || outOfPostponed) return "rescheduled";
  if (after.status === "confirmed" && (before.status === "expected" || before.status === "announced")) return "confirmed";
  return "changed";
}

// ---- Slugs ----

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug === "" ? "experience" : slug;
}

// The slug from the title, then with the year of the first date, then with a counter, whichever is free first.
export function uniqueSlug(base: string, year: string | null, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const withYear = year === null ? base : `${base}-${year}`;
  if (!taken.has(withYear)) return withYear;
  for (let counter = 2; ; counter += 1) {
    const candidate = `${withYear}-${counter}`;
    if (!taken.has(candidate)) return candidate;
  }
}
