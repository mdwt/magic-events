import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDue, nextFetch, type DueInput, type RecentRun } from "../src/core/discovery/due.ts";

// When a source is due a fetch: the weekly interval, five retries with a doubling wait after a failure, and a new
// round once they are used up. All from the source's runs, with no database.

const start = new Date("2026-11-23T08:00:00Z");
const minutes = (count: number) => new Date(start.getTime() + count * 60 * 1000);
const hours = (count: number) => minutes(count * 60);

function succeeded(at: Date): RecentRun {
  return { status: "succeeded", startedAt: at, finishedAt: new Date(at.getTime() + 60 * 1000) };
}
// A failed run that finished a minute after it started.
function failed(at: Date): RecentRun {
  return { status: "failed", startedAt: at, finishedAt: new Date(at.getTime() + 60 * 1000) };
}

// Weekly, with the default five retries starting at 15 minutes. Runs are given oldest first and handed over
// most recent first, as the repository gives them.
function input(...oldestFirst: RecentRun[]): DueInput {
  return { fetchIntervalHours: 168, runs: [...oldestFirst].reverse(), fetchRetries: 5, fetchRetryBackoffMinutes: 15 };
}

// A succeeded run, then `count` failed ones, each starting when the one before became due.
function failures(count: number): RecentRun[] {
  const runs = [succeeded(start)];
  for (let index = 0; index < count; index += 1) {
    const next = nextFetch(input(...runs));
    assert.ok(next.kind === "retry" || next.kind === "regular");
    runs.push(failed(next.at));
  }
  return runs;
}

describe("When a source is due", () => {
  test("a source that has never run is due", () => {
    assert.equal(isDue(input(), start), true);
    assert.deepEqual(nextFetch(input()), { kind: "never_ran" });
  });

  test("a source that is running is not due, however long ago its last success was", () => {
    const running: RecentRun = { status: "running", startedAt: hours(1), finishedAt: null };
    assert.equal(isDue(input(succeeded(start), running), hours(10_000)), false);
  });

  test("after a success it is due one interval after that run started, and not before", () => {
    const runs = input(succeeded(start));
    assert.equal(isDue(runs, new Date(hours(168).getTime() - 1)), false);
    assert.equal(isDue(runs, hours(168)), true);
    assert.deepEqual(nextFetch(runs), { kind: "regular", at: hours(168), retriesUsedUp: false });
  });

  test("each of the five retries waits 15, 30, 60, 120 and 240 minutes after the failed run finished", () => {
    const waits = [15, 30, 60, 120, 240];
    for (const [index, wait] of waits.entries()) {
      const runs = failures(index + 1);
      const last = runs.at(-1);
      assert.ok(last?.finishedAt);
      const due = new Date(last.finishedAt.getTime() + wait * 60 * 1000);

      const next = nextFetch(input(...runs));
      assert.deepEqual(next, { kind: "retry", retry: index + 1, at: due });
      assert.equal(isDue(input(...runs), new Date(due.getTime() - 1)), false, `retry ${index + 1} just before`);
      assert.equal(isDue(input(...runs), due), true, `retry ${index + 1} at its time`);
    }
  });

  test("when the retries are used up it waits one interval after the last run started", () => {
    const runs = failures(6);
    const last = runs.at(-1);
    assert.ok(last);
    const regular = new Date(last.startedAt.getTime() + 168 * 60 * 60 * 1000);

    assert.deepEqual(nextFetch(input(...runs)), { kind: "regular", at: regular, retriesUsedUp: true });
    assert.equal(isDue(input(...runs), hours(100)), false);
    assert.equal(isDue(input(...runs), regular), true);
  });

  test("a failure after the retries were used up begins a new round of retries", () => {
    const runs = failures(7);
    const last = runs.at(-1);
    assert.ok(last?.finishedAt);
    assert.deepEqual(nextFetch(input(...runs)), {
      kind: "retry",
      retry: 1,
      at: new Date(last.finishedAt.getTime() + 15 * 60 * 1000),
    });
  });

  test("a success in between resets the count", () => {
    const runs = [...failures(4), succeeded(hours(3)), failed(hours(200))];
    // Only the run after the success has failed, so this is the first retry again.
    assert.deepEqual(nextFetch(input(...runs)), { kind: "retry", retry: 1, at: new Date(hours(200).getTime() + 16 * 60 * 1000) });
  });

  test("with no retries, a failed fetch waits for the next regular fetch", () => {
    const next = nextFetch({ ...input(failed(start)), fetchRetries: 0 });
    assert.deepEqual(next, { kind: "regular", at: hours(168), retriesUsedUp: true });
  });
});
