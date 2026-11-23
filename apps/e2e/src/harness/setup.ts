import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "./api.ts";
import { captures, commandEnv, keysPrinted, migrate, pipeline, seed } from "./cli.ts";
import { databaseUrl, dropDatabase, literal, one, query } from "./db.ts";
import { baseEnv, ROOT, runCommand, type CommandResult } from "./process.ts";
import { ApiServer } from "./server.ts";
import { remember, state } from "./state.ts";

// Sets the run up: its own database, dropped and created fresh, migrated, seeded with the real seed command, loaded
// with a temporary copy of the captured pages, then the real server on a free port.

// A schedule that never fires during a run, so no live website is fetched: 29 February, next in 2028.
export const NEVER = "0 0 29 2 *";

const SEEDED_TABLES = ["location", "attribute", "attribute_option", "tag", "season", "season_period", "source", "tenant", '"user"', "apikey"];

export interface Snapshot {
  rows: Record<string, number>;
  digest: string;
}

// A fingerprint of every row the seed writes, to tell whether a second seed changed anything.
export async function seededSnapshot(): Promise<Snapshot> {
  const rows: Record<string, number> = {};
  const digests: string[] = [];
  for (const table of SEEDED_TABLES) {
    const found = await one<{ n: number; digest: string | null }>(
      state.dbUrl,
      `select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from ${table} t`,
    );
    rows[table] = found.n;
    digests.push(found.digest ?? "");
  }
  return { rows, digest: digests.join(",") };
}

// What the system knows about a key: its user, tenant and credential ID, read from the database by the user's email
// and the key's name.
export async function clientFor(label: string, email: string, keyName: string, key: string): Promise<Client> {
  const found = await one<{
    user_id: string;
    tenant_id: string | null;
    tenant_slug: string | null;
    role: "client" | "system_admin";
    credential_id: string;
    metadata: string | null;
  }>(
    state.dbUrl,
    `select u.id as user_id, u.tenant_id, t.slug as tenant_slug, u.role, k.id as credential_id, k.metadata
       from "user" u left join tenant t on t.id = u.tenant_id join apikey k on k.reference_id = u.id
      where u.email = ${literal(email)} and k.name = ${literal(keyName)}
      order by k.created_at desc limit 1`,
  );
  const kind = (found.metadata ?? "").includes("agent") ? "agent" : "person";
  const made: Client = {
    label,
    key,
    email,
    userId: found.user_id,
    tenantId: found.tenant_id,
    tenantSlug: found.tenant_slug,
    kind,
    role: found.role,
    credentialId: found.credential_id,
  };
  state.clients.set(label, made);
  state.keys.add(key);
  return made;
}

const SEEDED_LABELS: Record<string, string> = {
  "planner@agency.example.com person": "agency person",
  "planner@agency.example.com agent": "agency agent",
  "planner@app.example.com person": "app person",
  "planner@app.example.com agent": "app agent",
  "admin@example.com person": "admin",
};

export function serverEnv(extra: Record<string, string> = {}): Record<string, string> {
  return commandEnv({
    DISCOVERY_SCHEDULE_CRON: NEVER,
    CATALOGUE_UPKEEP_CRON: NEVER,
    ...extra,
  });
}

export async function startServer(name: string, extra: Record<string, string> = {}): Promise<ApiServer> {
  const server = await ApiServer.start({ name, dir: state.tmp, env: serverEnv(extra) });
  state.servers.push(server);
  return server;
}

async function migrationCount(): Promise<number> {
  const found = await one<{ n: number }>(state.dbUrl, "select count(*)::int as n from drizzle.__drizzle_migrations");
  return found.n;
}

function mustSucceed(result: CommandResult, what: string): void {
  if (result.code !== 0) throw new Error(`${what} exited with ${String(result.code)}: ${result.output.slice(-1500)}`);
}

export async function prepare(): Promise<void> {
  state.tmp = mkdtempSync(join(tmpdir(), "magic-events-e2e-"));
  state.secret = randomBytes(36).toString("base64");
  state.env = baseEnv({}, state.live);
  state.dbUrl = databaseUrl(state.dbName);

  // C-04: an empty database takes every migration, and a second run applies nothing.
  await dropDatabase(state.dbName);
  const first = await migrate(state.dbUrl);
  mustSucceed(first, "The migration");
  const applied = await migrationCount();
  const second = await migrate(state.dbUrl);
  remember("C-04", { first, second, applied, again: await migrationCount() });

  // C-05: the seed, twice.
  const seeded = await seed();
  mustSucceed(seeded, "The seed");
  const before = await seededSnapshot();
  const reseeded = await seed();
  remember("C-05", { first: seeded, second: reseeded, before, after: await seededSnapshot() });

  for (const printed of keysPrinted(seeded.stdout)) {
    const label = SEEDED_LABELS[`${printed.email} ${printed.kind}`];
    if (label !== undefined) await clientFor(label, printed.email, printed.name, printed.key);
  }
  for (const label of Object.values(SEEDED_LABELS)) {
    if (!state.clients.has(label)) throw new Error(`The seed printed no key for ${label}`);
  }

  // E2E-20: the captured pages, from a copy the scenarios can edit.
  cpSync(join(ROOT, "data/hermanus"), join(state.tmp, "hermanus"), { recursive: true });
  state.capturesDir = join(state.tmp, "hermanus");
  remember("T0", new Date().toISOString());
  const loaded = await captures();
  mustSucceed(loaded, "The captures load");
  remember("load", loaded);
  if (state.live) remember("embed", await pipeline(["embed"]));
  remember(
    "experiences after load",
    await query<{ id: string; title: string; version: number }>(state.dbUrl, "select id, title, version from experience"),
  );

  const startedAt = Date.now();
  state.main = await startServer("main");
  remember("main started", Date.now() - startedAt);
}

export async function tearDown(): Promise<string[]> {
  const notes: string[] = [];
  for (const server of state.servers) {
    if (server.running) await server.stop("SIGTERM");
  }
  if (state.keep) {
    notes.push(`Kept the database ${state.dbName} and ${state.tmp} (E2E_KEEP=1).`);
    return notes;
  }
  try {
    await dropDatabase(state.dbName);
    await dropDatabase(`${state.dbName}_live`);
  } catch (error) {
    notes.push(`Could not drop the database: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (state.tmp !== "") rmSync(state.tmp, { recursive: true, force: true });
  return notes;
}

export async function commitRunAgainst(): Promise<string> {
  const head = await runCommand("git", ["rev-parse", "--short", "HEAD"], { env: { PATH: process.env.PATH ?? "" } });
  const dirty = await runCommand("git", ["status", "--porcelain", "--untracked-files=no"], {
    env: { PATH: process.env.PATH ?? "" },
  });
  const changed = dirty.stdout.split("\n").filter((line) => line.trim() !== "").length;
  return `${head.stdout.trim()}${changed > 0 ? ` with ${changed} uncommitted changes in the working tree` : ""}`;
}
