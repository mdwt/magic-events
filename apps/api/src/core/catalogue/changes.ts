import { REPORTED_CHANGE_KINDS, type ReportedChange } from "./ports.ts";

// The rules of changed-since (UC2): which one change an experience is reported as, from its changes since the time
// the client gives.

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
