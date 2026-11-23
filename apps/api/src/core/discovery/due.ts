// When a source is due a fetch, worked out from its last run. Trying a failed fetch again is the job queue's work.
//
// - Never run: due.
// - Its last run is still running: not due.
// - Otherwise, succeeded or failed: due one fetch interval after that run started.

export interface LastRun {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: Date;
}

const HOUR = 60 * 60 * 1000;

export function isDue(input: { fetchIntervalHours: number; lastRun: LastRun | null }, now: Date): boolean {
  const { lastRun } = input;
  if (lastRun === null) return true;
  if (lastRun.status === "running") return false;
  return lastRun.startedAt.getTime() + input.fetchIntervalHours * HOUR <= now.getTime();
}

// The moment before which a run still running did not finish: it started more than the run timeout ago.
export function staleBefore(now: Date, runTimeoutMinutes: number): Date {
  return new Date(now.getTime() - runTimeoutMinutes * 60 * 1000);
}
