// rrule ships as a CommonJS bundle, so under Node's ES modules its exports come through the default import.
import rrule from "rrule";

const { RRule } = rrule;

// Days are plain YYYY-MM-DD strings. Every calculation runs on UTC midnights, so no day drifts across a timezone
// or a daylight-saving boundary: a day is a calendar day, not an instant.

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toUtc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addMonths(day: string, months: number): string {
  const date = toUtc(day);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  // The same day of the month, or the month's last day when it is shorter.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return fromUtc(target);
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function endOfMonth(day: string): string {
  const date = toUtc(day);
  return fromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

export function startOfYear(day: string): string {
  return `${day.slice(0, 4)}-01-01`;
}

export function endOfYear(day: string): string {
  return `${day.slice(0, 4)}-12-31`;
}

// The calendar day it is in the timezone at the given instant.
export function dayIn(timezone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((one) => one.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// The frequencies a rule may have. A rule that repeats within a day makes no sense for an experience, and an
// open-ended one would give millions of dates.
const DAILY_OR_LONGER = new Set<number>([RRule.YEARLY, RRule.MONTHLY, RRule.WEEKLY, RRule.DAILY]);

type RuleOptions = ReturnType<typeof RRule.parseString>;

// The rule's options, or null when it cannot be used. rrule's parser accepts much that it cannot run, so the
// options are also checked and the rule tried once.
function parseRule(rule: string): RuleOptions | null {
  let options: RuleOptions;
  try {
    options = RRule.parseString(rule);
  } catch {
    return null;
  }
  if (options.freq === undefined || !DAILY_OR_LONGER.has(options.freq)) return null;
  if (options.count !== undefined && options.count !== null && !Number.isInteger(options.count)) return null;
  // The first date comes from the recurrence, never from the rule text.
  delete options.dtstart;
  delete options.tzid;
  try {
    new RRule({ ...options, dtstart: toUtc("2000-01-01") }).after(toUtc("2000-01-01"), true);
  } catch {
    return null;
  }
  return options;
}

export function isValidRule(rule: string): boolean {
  return parseRule(rule) !== null;
}

// The days the rule gives, counted from the recurrence's first date, that fall from `from` to `to`, both included.
export function ruleDays(recurrence: { rule: string; start: string }, from: string, to: string): string[] {
  const options = parseRule(recurrence.rule);
  if (options === null) throw new Error(`The recurrence rule ${recurrence.rule} cannot be used`);
  if (to < from) return [];
  const dates = new RRule({ ...options, dtstart: toUtc(recurrence.start) }).between(
    toUtc(from),
    // The whole of the last day, in case the rule sets a time of day.
    new Date(toUtc(to).getTime() + 86_399_999),
    true,
  );
  return [...new Set(dates.map(fromUtc))];
}
