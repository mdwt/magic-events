import { join } from "node:path";
import { ROOT, runNode, type CommandResult } from "./process.ts";
import type { LogLine } from "./server.ts";
import { state } from "./state.ts";

// The system's command-line tools, run as child processes against the end-to-end database, as an operator runs
// them: the seed, the captures loader, the pipeline and the admin commands.

export function commandEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...state.env,
    DATABASE_URL: state.dbUrl,
    BETTER_AUTH_SECRET: state.secret,
    LOG_LEVEL: "debug",
    LOG_PRETTY: "false",
    ...extra,
  };
}

async function cli(script: string, args: string[], extra: Record<string, string> = {}): Promise<CommandResult> {
  const result = await runNode(join(ROOT, script), args, { env: commandEnv(extra), timeoutMs: 15 * 60_000 });
  state.commands.push(result);
  return result;
}

export function seed(): Promise<CommandResult> {
  return cli("apps/cli/src/seed/run.ts", []);
}

// The captures command, always from the run's own copy of data/hermanus and never asking the language model.
export function captures(args: string[] = []): Promise<CommandResult> {
  return cli("apps/cli/src/load-captures.ts", ["--no-model", "--dir", state.capturesDir, ...args]);
}

export function pipeline(args: string[], extra: Record<string, string> = {}): Promise<CommandResult> {
  return cli("apps/cli/src/pipeline.ts", args, extra);
}

export function admin(args: string[], extra: Record<string, string> = {}): Promise<CommandResult> {
  return cli("apps/cli/src/admin.ts", args, extra);
}

export function migrate(url: string): Promise<CommandResult> {
  return runNode(join(ROOT, "packages/db/src/cli/migrate.ts"), ["DATABASE_URL"], {
    env: { ...state.env, DATABASE_URL: url },
    timeoutMs: 120_000,
  });
}

// The JSON log lines a command wrote, apart from what it printed for a person.
export function logLinesOf(result: CommandResult): LogLine[] {
  return result.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line): LogLine[] => {
      try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === "object" && parsed !== null ? [parsed as LogLine] : [];
      } catch {
        return [];
      }
    });
}

// What a command printed for a person: every line that is not a log line.
export function printedOf(result: CommandResult): string {
  return result.output
    .split("\n")
    .filter((line) => !line.startsWith("{"))
    .join("\n");
}

export interface SeededKey {
  userName: string;
  email: string;
  kind: "person" | "agent";
  name: string;
  key: string;
}

export function keysPrinted(output: string): SeededKey[] {
  return [...output.matchAll(/^(.+?) <([^>]+)>, (person|agent) key "([^"]+)"\n\s+(mev_\S+)/gm)].map((match) => ({
    userName: match[1] ?? "",
    email: match[2] ?? "",
    kind: match[3] === "agent" ? "agent" : "person",
    name: match[4] ?? "",
    key: match[5] ?? "",
  }));
}

// A per-source line of the captures command: "  NAME (kind[, inactive]): F listings, N new or changed; ...".
export interface CapturedSourceLine {
  name: string;
  listings: number;
  newOrChanged: number;
  saved: number;
  created: number;
  changed: number;
  failed: boolean;
}

export function capturedSources(output: string): CapturedSourceLine[] {
  const lines: CapturedSourceLine[] = [];
  for (const match of output.matchAll(
    /^ {2}(.+?) \((?:[a-z_]+)(?:, inactive)?\): (\d+) listings, (\d+) new or changed; \d+ experiences captured, (\d+) saved, (\d+) new, (\d+) changed$/gm,
  )) {
    lines.push({
      name: match[1] ?? "",
      listings: Number(match[2]),
      newOrChanged: Number(match[3]),
      saved: Number(match[4]),
      created: Number(match[5]),
      changed: Number(match[6]),
      failed: false,
    });
  }
  for (const match of output.matchAll(/^ {2}(.+?): the run FAILED: (.*)$/gm)) {
    lines.push({ name: match[1] ?? "", listings: 0, newOrChanged: 0, saved: 0, created: 0, changed: 0, failed: true });
  }
  return lines;
}
