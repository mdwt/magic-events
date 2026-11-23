import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ROOT } from "./process.ts";

// The real server, apps/api/src/server.ts, as a child process on a free port, with its output written to a log file
// the suite reads back line by line.

export type LogLine = Record<string, unknown> & { level?: number; msg?: string };

export const LEVEL = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

export class ApiServer {
  readonly name: string;
  readonly port: number;
  readonly logPath: string;
  readonly baseUrl: string;
  readonly env: Record<string, string>;
  exitCode: number | null = null;
  #child: ChildProcess | undefined;
  #exited: Promise<number | null> = Promise.resolve(null);
  #running = false;

  constructor(name: string, port: number, dir: string, env: Record<string, string>) {
    this.name = name;
    this.port = port;
    this.logPath = join(dir, `${name}.log`);
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.env = env;
  }

  get running(): boolean {
    return this.#running;
  }

  // Starts the server and waits until it answers /health and, when asked, until its jobs have started.
  static async start(options: {
    name: string;
    dir: string;
    env: Record<string, string>;
    waitForJobs?: boolean;
  }): Promise<ApiServer> {
    const port = await freePort();
    const env = { ...options.env, API_HOST: "127.0.0.1", API_PORT: String(port) };
    const server = new ApiServer(options.name, port, options.dir, env);
    server.#spawn();
    try {
      await until(
        `${options.name} to answer /health`,
        async () => {
          if (!server.#running) throw new Error(`${options.name} exited with ${String(server.exitCode)}:\n${server.tail()}`);
          try {
            const response = await fetch(`${server.baseUrl}/health`);
            await response.arrayBuffer();
            return true;
          } catch {
            return undefined;
          }
        },
        60_000,
      );
      if (options.waitForJobs !== false) {
        await until(`${options.name} to start its jobs`, () => server.find((line) => line.msg === "The jobs started"), 60_000);
      }
    } catch (error) {
      await server.stop("SIGKILL");
      throw error;
    }
    return server;
  }

  #spawn(): void {
    const fd = openSync(this.logPath, "a");
    const child = spawn(process.execPath, ["apps/api/src/server.ts"], {
      cwd: ROOT,
      env: this.env,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    this.#child = child;
    this.#running = true;
    this.#exited = new Promise((resolve) => {
      child.on("exit", (code) => {
        this.#running = false;
        this.exitCode = code;
        resolve(code);
      });
    });
  }

  // Every line written so far, from the line number given. A line that is not JSON is kept as { raw }.
  lines(from = 0): LogLine[] {
    return this.text()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(from)
      .map((line): LogLine => {
        try {
          const parsed: unknown = JSON.parse(line);
          return typeof parsed === "object" && parsed !== null ? (parsed as LogLine) : { raw: line };
        } catch {
          return { raw: line };
        }
      });
  }

  lineCount(): number {
    return this.lines().length;
  }

  find(predicate: (line: LogLine) => boolean, from = 0): LogLine | undefined {
    return this.lines(from).find(predicate);
  }

  waitFor(what: string, predicate: (line: LogLine) => boolean, timeoutMs = 5_000, from = 0): Promise<LogLine> {
    return until(`${this.name}'s log to show ${what}`, () => this.find(predicate, from), timeoutMs, 100);
  }

  text(): string {
    try {
      return readFileSync(this.logPath, "utf8");
    } catch {
      return "";
    }
  }

  tail(count = 20): string {
    return this.text().trimEnd().split("\n").slice(-count).join("\n");
  }

  // Stops the server and waits for it to exit. A server that does not stop in time is killed.
  async stop(signal: NodeJS.Signals = "SIGTERM", timeoutMs = 45_000): Promise<number | null> {
    if (!this.#running || this.#child === undefined) return this.exitCode;
    this.#child.kill(signal);
    const timer = setTimeout(() => this.#child?.kill("SIGKILL"), timeoutMs);
    const code = await this.#exited;
    clearTimeout(timer);
    return code;
  }
}
