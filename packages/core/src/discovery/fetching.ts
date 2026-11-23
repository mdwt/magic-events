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

// Text as a Postgres text column can hold it. Postgres refuses the NUL character, which some pages carry, and
// stores a lone half of a surrogate pair as U+FFFD, so that is replaced here, before the fingerprint is taken from
// it. Bytes that are not valid in the page's character set are already U+FFFD once the body is decoded.
export function storableText(text: string): string {
  return text.replaceAll("\u0000", "").toWellFormed();
}

// A listing as fetched, with every text in it storable. Discovery saves and fingerprints only this.
export function storableListing(listing: FetchedListing): FetchedListing {
  return {
    sourceListingId: storableText(listing.sourceListingId),
    ...(listing.url === undefined ? {} : { url: storableText(listing.url) }),
    contentType: storableText(listing.contentType),
    content: storableText(listing.content),
    ...(listing.fingerprintOf === undefined ? {} : { fingerprintOf: storableText(listing.fingerprintOf) }),
  };
}

// The longest error a run records.
const MAX_ERROR_LENGTH = 500;

// Why something failed, short, for the run's error. A failed query's error carries the query and its parameters,
// which can hold a whole page, so the database's own reason is given instead.
export function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && message.startsWith("Failed query:")) {
    message = error.cause instanceof Error ? `The database refused a query: ${error.cause.message}` : "A query failed.";
  }
  const line = storableText(message).replace(/\s+/g, " ").trim();
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}
