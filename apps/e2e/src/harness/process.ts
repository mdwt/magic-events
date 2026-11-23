import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Running the system's own commands as child processes, with an environment the suite builds itself, so nothing
// from the shell or the repository's .env reaches them unless the suite passes it on.

export const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export interface CommandResult {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  // stdout and stderr together, in the order they came.
  output: string;
  durationMs: number;
}

// The variables every child gets from the suite's own environment: enough to find node, pnpm and psql.
const PASSED_THROUGH = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "SHELL"];

// The variables that reach the outside world. Only `pnpm e2e:live` passes them on.
export const LIVE_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "QUICKET_API_KEY",
  "TICKETMASTER_API_KEY",
];

export function baseEnv(extra: Record<string, string>, live: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...PASSED_THROUGH, ...(live ? LIVE_VARIABLES : [])]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return { ...env, ...extra };
}

export function runCommand(
  command: string,
  args: string[],
  options: { env: Record<string, string>; timeoutMs?: number; cwd?: string },
): Promise<CommandResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 10 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        code,
        stdout,
        stderr,
        output,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

// A TypeScript entry point of the repository, run by Node directly, as the package scripts do.
export function runNode(
  script: string,
  args: string[],
  options: { env: Record<string, string>; timeoutMs?: number },
): Promise<CommandResult> {
  return runCommand(process.execPath, [script, ...args], options);
}

export function lastLines(text: string, count = 15): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
