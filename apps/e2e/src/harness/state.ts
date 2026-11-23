import type { Client } from "./api.ts";
import type { CommandResult } from "./process.ts";
import type { ApiServer } from "./server.ts";

// What the run holds between scenarios: its settings, its database, its servers, the keys it was given, and the
// answers later scenarios compare against.

export interface State {
  live: boolean;
  keep: boolean;
  skipChecks: boolean;
  // E2E_KEEP_LOGS=1: the servers' logs, the commands' output and the table are copied to a folder of results/.
  keepLogs: boolean;
  keptDir: string | undefined;
  // E2E_ONLY=C-09,E2E-05: only these scenarios run, after the set-up.
  only: string[];
  startedAt: Date;
  tmp: string;
  dbName: string;
  dbUrl: string;
  secret: string;
  capturesDir: string;
  // The environment every command and server of the run gets, before its own settings.
  env: Record<string, string>;
  main: ApiServer | undefined;
  servers: ApiServer[];
  clients: Map<string, Client>;
  // Every key the run saw, to search the logs for.
  keys: Set<string>;
  commands: CommandResult[];
  setupError: string | undefined;
  // What one scenario leaves for another, such as E2E-01's answer or the time T1.
  memo: Map<string, unknown>;
}

export const state: State = {
  live: process.argv.includes("--live"),
  keep: process.env.E2E_KEEP === "1",
  skipChecks: process.env.E2E_SKIP_CHECKS === "1",
  keepLogs: process.env.E2E_KEEP_LOGS === "1",
  keptDir: undefined,
  only: (process.env.E2E_ONLY ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  startedAt: new Date(),
  tmp: "",
  dbName: "magic_events_e2e",
  dbUrl: "",
  secret: "",
  capturesDir: "",
  env: {},
  main: undefined,
  servers: [],
  clients: new Map(),
  keys: new Set(),
  commands: [],
  setupError: undefined,
  memo: new Map(),
};

export function client(label: string): Client {
  const found = state.clients.get(label);
  if (found === undefined) throw new Error(`The run holds no key for ${label}`);
  return found;
}

export function mainServer(): ApiServer {
  if (state.main === undefined) throw new Error("The main server is not running");
  return state.main;
}

export function remember(name: string, value: unknown): void {
  state.memo.set(name, value);
}

// The caller names what it expects back; the memo holds whatever each scenario left.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function recall<T>(name: string): T | undefined {
  return state.memo.get(name) as T | undefined;
}
