import type { StoredExperience } from "./ports.ts";
import { addMonths, dayIn } from "./recurrence.ts";
import { FINAL_STATUSES, allowedBooking, generateSessions, sameSessions, sortSessions } from "./save.ts";

// The rules of Catalogue's upkeep (docs/data-model.md): what is due on one experience as time passes.

// The timezone furthest ahead of UTC. No experience's today is later than today there.
export const LATEST_TIMEZONE = "Pacific/Kiritimati";

const ENDS: readonly StoredExperience["status"][] = ["expected", "announced", "confirmed"];

export interface Upkeep {
  // The experience as the upkeep leaves it.
  experience: StoredExperience;
  // The kind of the new version, or null when only sessions were generated, which is no change.
  change: "past" | "changed" | null;
  // How many sessions were generated further ahead.
  generated: number;
  // True when its sessions are stored again.
  sessionsChanged: boolean;
}

// What the upkeep does to the experience at the given time, or null when nothing is due.
// - An Expected, Announced or Confirmed experience whose last session ended before today, in its own timezone, is
//   set to Past, with booking Closed unless it is None. An open-ended recurring experience has no last date.
// - Otherwise a booking that is Not yet or Open whose close time has passed is Closed.
// - An open-ended recurring experience gets the sessions its rule gives up to the horizon from today, which is
//   not a change.
export function upkeepOf(stored: StoredExperience, at: Date, horizonMonths: number): Upkeep | null {
  if (FINAL_STATUSES.includes(stored.status)) return null;
  const today = dayIn(stored.timezone, at);
  const openEnded = stored.recurrence !== null && stored.recurrence.end === null;
  const lastDate = stored.sessions.reduce<string | null>(
    (last, session) => (last === null || session.endDate > last ? session.endDate : last),
    null,
  );

  let next: StoredExperience = stored;
  let change: Upkeep["change"] = null;
  if (ENDS.includes(stored.status) && !openEnded && lastDate !== null && lastDate < today) {
    next = { ...stored, status: "past", booking: allowedBooking("past", stored.booking) };
    change = "past";
  } else if (
    (stored.booking === "not_yet" || stored.booking === "open") &&
    stored.bookingClosesAt !== null &&
    new Date(stored.bookingClosesAt) <= at
  ) {
    next = { ...stored, booking: "closed" };
    change = "changed";
  }

  let generated = 0;
  let sessionsChanged = false;
  if (openEnded) {
    const listed = stored.sessions.filter((session) => session.origin === "listed");
    const before = stored.sessions.filter((session) => session.origin === "generated");
    const after = generateSessions({
      recurrence: stored.recurrence,
      listed,
      generated: before,
      today,
      horizon: addMonths(today, horizonMonths),
    });
    const had = new Set(before.map((session) => session.startDate));
    generated = after.filter((session) => !had.has(session.startDate)).length;
    const sessions = sortSessions([...listed, ...after]);
    sessionsChanged = !sameSessions(stored.sessions, sessions);
    if (sessionsChanged) next = { ...next, sessions };
  }

  if (change === null && !sessionsChanged) return null;
  return {
    experience: change === null ? next : { ...next, version: stored.version + 1 },
    change,
    generated,
    sessionsChanged,
  };
}
