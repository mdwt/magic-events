import { isDeepStrictEqual } from "node:util";

// The conditions of one scenario. Each failed condition is kept, so a run shows everything that was wrong in a
// scenario, not only the first thing, and the results table says what was seen.

export class Checks {
  readonly problems: string[] = [];
  readonly notes: string[] = [];
  // What was asked and what came back, with a count or a name, for the test report.
  readonly evidence: string[] = [];

  saw(line: string): void {
    this.evidence.push(line);
  }

  ok(condition: boolean, what: string): boolean {
    if (!condition) this.problems.push(what);
    return condition;
  }

  equal(actual: unknown, expected: unknown, what: string): boolean {
    const same = isDeepStrictEqual(actual, expected);
    if (!same) this.problems.push(`${what}: expected ${show(expected)}, saw ${show(actual)}`);
    return same;
  }

  // Two lists of names that must hold the same names, whatever the order: says which are missing and which are extra.
  sameSet(actual: string[], expected: string[], what: string): boolean {
    const missing = expected.filter((one) => !actual.includes(one));
    const extra = actual.filter((one) => !expected.includes(one));
    if (missing.length === 0 && extra.length === 0) return true;
    this.problems.push(`${what}: missing ${show(missing, 2000)}, not expected ${show(extra, 2000)}`);
    return false;
  }

  fail(what: string): void {
    this.problems.push(what);
  }

  // Something the reader should know that is not a failure, such as a part left for the live run.
  note(what: string): void {
    this.notes.push(what);
  }

  get passed(): boolean {
    return this.problems.length === 0;
  }
}

export function show(value: unknown, max = 240): string {
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) as string | undefined) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
