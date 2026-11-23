import { test } from "node:test";
import { calls, setScenario } from "./api.ts";
import { Checks } from "./checks.ts";
import { checkCallLogs, waitForClosingLines } from "./logs.ts";
import { state } from "./state.ts";

// A scenario of docs/end-to-end.md as a named test carrying its ID, followed by a second test that reads the lines
// the server wrote for it. Each records its outcome for the results table.

export type Outcome = "pass" | "fail" | "by hand" | "live" | "skipped" | "not run";

export interface Row {
  id: string;
  title: string;
  result: Outcome;
  logs: "pass" | "fail" | "";
  seen: string[];
  notes: string[];
}

export const rows = new Map<string, Row>();

export interface Scenario {
  c: Checks;
  // Log conditions of this scenario, checked with the request lines once the scenario has run.
  logs: (check: (c: Checks) => void | Promise<void>) => void;
}

function row(id: string, title: string): Row {
  const existing = rows.get(id);
  if (existing !== undefined) return existing;
  const created: Row = { id, title, result: "not run", logs: "", seen: [], notes: [] };
  rows.set(id, created);
  return created;
}

function combine(current: Outcome, next: Outcome): Outcome {
  if (current === "fail" || next === "fail") return "fail";
  if (current === "not run") return next;
  if (current === "pass" || next === "pass") return "pass";
  return next;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scenario(
  id: string,
  title: string,
  run: (s: Scenario) => Promise<void>,
  options: { live?: boolean; needsSetup?: boolean } = {},
): void {
  const record = row(id, title);
  if (options.live === true && !state.live) {
    record.result = combine(record.result, "live");
    record.notes.push("Runs with pnpm e2e:live.");
    test(`${id} ${title}`, { skip: "needs pnpm e2e:live" }, () => undefined);
    return;
  }

  const logChecks: ((c: Checks) => void | Promise<void>)[] = [];
  test(`${id} ${title}`, async () => {
    setScenario(id);
    const c = new Checks();
    if (state.setupError !== undefined && options.needsSetup !== false) {
      c.fail(`The run could not be set up: ${state.setupError}`);
    } else {
      try {
        await run({ c, logs: (check) => logChecks.push(check) });
      } catch (error) {
        c.fail(`Stopped: ${message(error)}`);
      }
    }
    record.result = combine(record.result, c.passed ? "pass" : "fail");
    record.seen.push(...c.problems);
    record.notes.push(...c.notes);
    if (!c.passed) throw new Error(c.problems.join("\n"));
  });

  test(`${id} logs`, async () => {
    const c = new Checks();
    const mine = calls.filter((call) => call.scenario === id);
    await waitForClosingLines(mine);
    for (const call of mine) checkCallLogs(call, c);
    for (const check of logChecks) {
      try {
        await check(c);
      } catch (error) {
        c.fail(`Stopped: ${message(error)}`);
      }
    }
    if (mine.length === 0 && logChecks.length === 0) return;
    const before = record.logs;
    record.logs = before === "fail" || !c.passed ? "fail" : "pass";
    record.seen.push(...c.problems.map((problem) => `log: ${problem}`));
    if (!c.passed) throw new Error(c.problems.join("\n"));
  });
}

// A scenario that cannot run yet, with the reason.
export function skipped(id: string, title: string, reason: string): void {
  const record = row(id, title);
  record.result = combine(record.result, "skipped");
  record.notes.push(reason);
  test(`${id} ${title}`, { skip: reason }, () => undefined);
}

// A scenario that needs a person or a live service the suite cannot stand in for.
export function byHand(id: string, title: string, what: string): void {
  const record = row(id, title);
  record.result = combine(record.result, "by hand");
  record.notes.push(what);
  test(`${id} ${title}`, { skip: `by hand: ${what}` }, () => undefined);
}
