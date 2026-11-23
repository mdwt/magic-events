import { runCommand } from "./process.ts";

// Reads of the end-to-end database through psql, to prepare it and to find expected values. The suite never changes
// the system's data this way, except where docs/end-to-end.md says a scenario needs it.

export const POSTGRES = "postgres://magic:magic@localhost:5434";

export function databaseUrl(name: string): string {
  return `${POSTGRES}/${name}`;
}

// Only the suite's own databases may be dropped or created here.
function guard(name: string): void {
  if (!/^magic_events_e2e(_[a-z0-9]+)?$/.test(name)) throw new Error(`Not an end-to-end database: ${name}`);
}

async function psql(url: string, sql: string): Promise<string> {
  const result = await runCommand("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], {
    env: { PATH: process.env.PATH ?? "", PGCONNECT_TIMEOUT: "5" },
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new Error(`psql failed: ${result.stderr.trim()}\n${sql}`);
  return result.stdout;
}

export async function query<T>(url: string, sql: string): Promise<T[]> {
  const text = await psql(url, `select coalesce(json_agg(t), '[]'::json) from (${sql}) t`);
  return JSON.parse(text) as T[];
}

export async function one<T>(url: string, sql: string): Promise<T> {
  const rows = await query<T>(url, sql);
  const [row] = rows;
  if (row === undefined) throw new Error(`No row for: ${sql}`);
  return row;
}

export async function execute(url: string, sql: string): Promise<void> {
  await psql(url, sql);
}

export async function dropDatabase(name: string): Promise<void> {
  guard(name);
  await execute(`${POSTGRES}/postgres`, `drop database if exists "${name}" with (force)`);
}

export async function createDatabase(name: string): Promise<void> {
  guard(name);
  await execute(`${POSTGRES}/postgres`, `create database "${name}"`);
}

// A literal for SQL, for the few values the suite puts in a query.
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
