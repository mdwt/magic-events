import {
  CHANGE_FIELDS,
  REPORTED_CHANGE_KINDS,
  previousValuesSchema,
  type ChangeField,
  type ChangedExperienceRecord,
  type PreviousValues,
  type ReportedChange,
} from "./ports.ts";

// The rules of changed-since (UC2): what each change says, from its change row, and which one change an experience
// is reported as, from its changes since the time the client gives.

type StoredChange = ChangedExperienceRecord["changes"][number];

// The stored field each field of the result is read from. A change to the recurrence is a change to the sessions.
const STORED_AS: Record<ChangeField, readonly string[]> = {
  title: ["title"],
  status: ["status"],
  booking: ["booking"],
  type: ["type"],
  sessions: ["sessions", "recurrence"],
  price: ["price"],
  venue: ["venue"],
  openingHours: ["openingHours"],
  onSaleAt: ["onSaleAt"],
  bookingClosesAt: ["bookingClosesAt"],
  bookingUrl: ["bookingUrl"],
  pageUrl: ["pageUrl"],
  imageUrl: ["imageUrl"],
  summary: ["summary"],
  description: ["description"],
  attributes: ["attributes"],
};

// Named in fields with no earlier value: long text, and an image, which a planner does not act on.
const NAMED_ONLY: readonly ChangeField[] = ["imageUrl", "summary", "description"];

function hourAndMinute(time: unknown): string | null {
  return typeof time === "string" ? time.slice(0, 5) : null;
}

// The sessions a change row holds, as the result shows sessions: the ones that were on, during the dates asked for.
// What the row does not hold is left out, never made up.
function sessionsThen(stored: unknown, dates: { from: string; to: string }): unknown {
  if (!Array.isArray(stored)) return undefined;
  return stored.flatMap((one: unknown) => {
    if (typeof one !== "object" || one === null) return [];
    const session = one as Record<string, unknown>;
    if (typeof session.startDate !== "string" || typeof session.endDate !== "string") return [];
    if (session.status === "cancelled") return [];
    if (session.startDate > dates.to || session.endDate < dates.from) return [];
    return [
      {
        startDate: session.startDate,
        endDate: session.endDate,
        precision: session.precision,
        startTime: hourAndMinute(session.startTime),
        endTime: hourAndMinute(session.endTime),
        label: session.label ?? null,
        ...(typeof session.soldOut === "boolean" ? { soldOut: session.soldOut } : {}),
      },
    ];
  });
}

// What one change says: the fields it changed, and what those were before, from the previous values its change row
// holds. A value that does not fit the result's shape for its field is left out.
export function changeOf(stored: StoredChange, dates: { from: string; to: string }): ReportedChange {
  const { kind, at } = stored;
  if (kind === "new" || stored.previous === null) return { kind, at, fields: [], previous: kind === "new" ? null : {} };
  const held = stored.previous;
  const fields = CHANGE_FIELDS.filter((field) => STORED_AS[field].some((key) => key in held));
  const previous: Record<string, unknown> = {};
  for (const field of fields) {
    if (NAMED_ONLY.includes(field)) continue;
    const value = field === "sessions" ? sessionsThen(held.sessions, dates) : held[field];
    if (value === undefined) continue;
    const read = previousValuesSchema.shape[field as keyof PreviousValues].safeParse(value);
    if (read.success && read.data !== undefined) previous[field] = read.data;
  }
  return { kind, at, fields, previous };
}

// The change to report, from the experience's changes since then, newest first. An experience first published since
// then is New to the client, unless it has since been cancelled or removed. Otherwise the kind that matters most to
// a planner is reported, at the time of the latest change of that kind. Null when there is no change.
export function reportedChange(changes: ReportedChange[]): ReportedChange | null {
  const latest = (kind: ReportedChange["kind"]) => changes.find((change) => change.kind === kind);
  const order = latest("new") === undefined ? REPORTED_CHANGE_KINDS : (["cancelled", "removed", "new"] as const);
  for (const kind of order) {
    const found = latest(kind);
    if (found !== undefined) return found;
  }
  return null;
}
