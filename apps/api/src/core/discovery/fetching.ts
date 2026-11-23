import { createHash } from "node:crypto";
import type { FetchedListing } from "./ports.ts";

// Pure helpers for a run: the sourcing window and a listing's fingerprint.

// The day it is at `now` in the time zone, as YYYY-MM-DD.
export function dayIn(now: Date, timeZone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// A YYYY-MM-DD day plus whole months. A day the later month does not have becomes its last day: 31 August plus six
// months is 28 or 29 February.
export function addMonths(day: string, months: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

// Today to the horizon, in the location's time zone.
export function sourcingWindow(now: Date, timeZone: string, horizonMonths: number): { from: string; to: string } {
  const from = dayIn(now, timeZone);
  return { from, to: addMonths(from, horizonMonths) };
}

// SHA-256 of what the adapter says to fingerprint, or else of the content.
export function fingerprint(listing: FetchedListing): string {
  return createHash("sha256")
    .update(listing.fingerprintOf ?? listing.content)
    .digest("hex");
}

// Why something failed, in one line for the run's error.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
