import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDue, staleBefore, type LastRun } from "../src/discovery/due.ts";

// When a source is due a fetch, from its last run alone, with no database. Retries are the job queue's.

const start = new Date("2026-11-23T08:00:00Z");
const hours = (count: number) => new Date(start.getTime() + count * 60 * 60 * 1000);

function last(status: LastRun["status"]): LastRun {
  return { id: "run-1", status, startedAt: start };
}

describe("When a source is due", () => {
  test("a source that has never run is due", () => {
    assert.equal(isDue({ fetchIntervalHours: 168, lastRun: null }, start), true);
  });

  test("a source with a run in progress is not due, however long the interval", () => {
    assert.equal(isDue({ fetchIntervalHours: 1, lastRun: last("running") }, hours(10_000)), false);
  });

  test("after a run that succeeded, it is due one interval after that run started, and not before", () => {
    const input = { fetchIntervalHours: 168, lastRun: last("succeeded") };
    assert.equal(isDue(input, new Date(hours(168).getTime() - 1)), false);
    assert.equal(isDue(input, hours(168)), true);
  });

  test("after a run that failed, it is due one interval after that run started too", () => {
    const input = { fetchIntervalHours: 168, lastRun: last("failed") };
    assert.equal(isDue(input, hours(1)), false);
    assert.equal(isDue(input, hours(168)), true);
  });

  test("a run is stale once it started more than the run timeout ago", () => {
    assert.equal(staleBefore(hours(1), 60).toISOString(), start.toISOString());
  });
});
