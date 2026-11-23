// When a source is due a fetch, worked out from its runs alone. There is no retry queue.
//
// - Never run: due now.
// - Running now: not due.
// - Last run succeeded: due one fetch interval after that run started.
// - Last run failed: n runs in a row have failed since the last success, and k = n mod (retries + 1).
//   k ≠ 0 is retry k, due backoff × 2^(k−1) minutes after the last run finished: 15, 30, 60, 120 and 240 minutes
//   with the defaults. k = 0 means the retries are used up: due one fetch interval after the last run started,
//   which begins a new round of retries if that fetch fails too.

export interface RecentRun {
  status: "running" | "succeeded" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
}

export type NextFetch =
  | { kind: "never_ran" }
  | { kind: "running" }
  | { kind: "regular"; at: Date; retriesUsedUp: boolean }
  | { kind: "retry"; retry: number; at: Date };

export interface DueInput {
  fetchIntervalHours: number;
  // The source's runs since its last success, that success included, most recent first.
  runs: RecentRun[];
  fetchRetries: number;
  fetchRetryBackoffMinutes: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export function nextFetch(input: DueInput): NextFetch {
  const [last] = input.runs;
  if (!last) return { kind: "never_ran" };
  if (last.status === "running") return { kind: "running" };

  const regular = new Date(last.startedAt.getTime() + input.fetchIntervalHours * HOUR);
  if (last.status === "succeeded") return { kind: "regular", at: regular, retriesUsedUp: false };

  let failed = 0;
  for (const run of input.runs) {
    if (run.status !== "failed") break;
    failed += 1;
  }
  const retry = failed % (input.fetchRetries + 1);
  if (retry === 0) return { kind: "regular", at: regular, retriesUsedUp: true };

  const finished = last.finishedAt ?? last.startedAt;
  const wait = input.fetchRetryBackoffMinutes * 2 ** (retry - 1) * MINUTE;
  return { kind: "retry", retry, at: new Date(finished.getTime() + wait) };
}

export function isDue(input: DueInput, now: Date): boolean {
  const next = nextFetch(input);
  if (next.kind === "never_ran") return true;
  if (next.kind === "running") return false;
  return next.at.getTime() <= now.getTime();
}
