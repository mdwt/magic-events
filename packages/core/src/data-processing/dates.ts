// Calendar dates as YYYY-MM-DD strings. Strings of that form sort in date order, so they are compared as text.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Rejects dates that do not exist, such as 2027-02-30, which Date would roll over into March.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// The calendar date of an instant in a timezone, such as the day a page was fetched in Hermanus.
export function dateIn(instant: Date, timezone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(instant);
}

// The time of day of an instant in a timezone, as HH:MM on a 24-hour clock.
export function timeIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(instant);
}

// The date some months later. A day that does not exist in the target month becomes that month's last day.
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = lastDayOfMonth(target.toISOString().slice(0, 7));
  return `${target.toISOString().slice(0, 8)}${String(Math.min(day, Number(last.slice(8)))).padStart(2, "0")}`;
}

// The last day of a month given as YYYY-MM.
export function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

export function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start <= b.end && b.start <= a.end;
}
