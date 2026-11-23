import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./process.ts";
import { rows, type Row } from "./scenario.ts";

// The results table: one row per ID of docs/end-to-end.md, printed at the end of the run and written to
// apps/e2e/results/latest.md.

export const IDS = [
  ...Array.from({ length: 8 }, (_, index) => `C-0${index + 1}`),
  ...Array.from({ length: 44 }, (_, index) => `E2E-${String(index + 1).padStart(2, "0")}`),
];

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function evidence(row: Row | undefined): string {
  return (row?.evidence ?? []).map(cell).join("; ");
}

function seen(row: Row | undefined): string {
  if (row === undefined) return "No scenario was registered for it.";
  const problems = row.seen.slice(0, 6).map(cell);
  if (row.seen.length > 6) problems.push(`and ${row.seen.length - 6} more`);
  return [...problems, ...row.notes.map(cell)].join("; ");
}

export function resultsTable(meta: { commit: string; startedAt: Date; durationMs: number; notes: string[] }): string {
  const lines = [
    "# End-to-end results",
    "",
    `Run on ${meta.startedAt.toISOString()} against ${meta.commit}, in ${Math.round(meta.durationMs / 1000)} s.`,
    "",
    "| ID | Result | Logs | Evidence | What was seen |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const id of IDS) {
    const row = rows.get(id);
    lines.push(`| ${id} | ${row?.result ?? "not run"} | ${row?.logs ?? ""} | ${evidence(row)} | ${seen(row)} |`);
  }
  // The suite's own rows: the set-up, and every operation of the OpenAPI document.
  for (const row of rows.values()) {
    if (!IDS.includes(row.id)) lines.push(`| ${row.id} | ${row.result} | ${row.logs} | ${evidence(row)} | ${seen(row)} |`);
  }
  const counts = new Map<string, number>();
  for (const id of IDS) {
    const result = rows.get(id)?.result ?? "not run";
    counts.set(result, (counts.get(result) ?? 0) + 1);
  }
  lines.push("", [...counts].map(([result, count]) => `${count} ${result}`).join(", ") + ".");
  for (const note of meta.notes) lines.push("", note);
  return `${lines.join("\n")}\n`;
}

export const RESULTS_DIR = join(ROOT, "apps/e2e/results");

// The table as latest.md, and in the run's own folder when E2E_KEEP_LOGS=1 kept one.
export function writeResults(table: string, keptDir: string | undefined): string[] {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const paths = [join(RESULTS_DIR, "latest.md")];
  if (keptDir !== undefined) paths.push(join(keptDir, "results.md"));
  for (const path of paths) writeFileSync(path, table);
  return paths;
}

export function anyFailed(): boolean {
  return [...rows.values()].some((row) => row.result === "fail" || row.logs === "fail");
}
