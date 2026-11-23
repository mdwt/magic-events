import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import postgres from "postgres";
import { ensureDatabase, migrateDatabase } from "../migrate.ts";

// The snapshot: the development database as one file in the repository, so a new checkout starts with a full feed
// and has no pages to fetch and no model to call.
//
//   snapshot.ts save               writes the database in DATABASE_URL to snapshot/hermanus.sql.gz
//   snapshot.ts restore            loads the snapshot into DATABASE_URL, when that database is empty or missing
//   snapshot.ts restore --replace  drops the database first
//
// The file is a whole dump, schema and data, with the record of the migrations it has had. So a restore is followed
// by the migrations added since it was saved, and the data moves forward as a live database's would.
//
// Left out: the organisations, the users and their API keys, which the seed creates and prints, since a key is
// stored only as a hash; and the job queue's own tables, which the server creates when it starts.
//
// pg_dump and psql are the ones inside the Postgres container, so they always match the server's version and
// nothing has to be installed.

const file = fileURLToPath(new URL("../../snapshot/hermanus.sql.gz", import.meta.url));
const composeFile = fileURLToPath(new URL("../../../../docker-compose.yml", import.meta.url));

// Tables whose rows stay out of the snapshot. Their definitions are in it.
const withoutRows = ["tenant", "user", "apikey", "session", "account", "verification"];

interface Target {
  url: string;
  name: string;
  user: string;
}

function target(): Target {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Not a usable database name: ${name}`);
  return { url, name, user: decodeURIComponent(parsed.username) };
}

// Starts a program of the Postgres container. Its errors go to this terminal.
function inContainer(args: string[], stdin: "pipe" | "ignore") {
  return spawn("docker", ["compose", "-f", composeFile, "exec", "-T", "postgres", ...args], {
    stdio: [stdin, "pipe", "inherit"],
  });
}

function finished(child: ReturnType<typeof spawn>, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(new Error(`${what} could not start. Is Docker running? ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${what} failed with exit code ${String(code)}. Is the database up? Run pnpm db:up.`));
    });
  });
}

// Runs one statement against the maintenance database, where a database is created and dropped.
async function maintenance(db: Target, statement: string): Promise<void> {
  const child = inContainer(["psql", "-U", db.user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qc", statement], "ignore");
  child.stdout?.resume();
  await finished(child, "psql");
}

// Postgres takes a moment to accept connections after `pnpm db:up`.
async function waitUntilReady(db: Target): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const child = spawn("docker", ["compose", "-f", composeFile, "exec", "-T", "postgres", "pg_isready", "-U", db.user], {
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", () => {
        resolve(null);
      });
      child.on("close", resolve);
    });
    if (code === 0) return;
    if (Date.now() > deadline) throw new Error("Postgres is not accepting connections. Run pnpm db:up and try again.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function tableCount(db: Target): Promise<number> {
  const client = postgres(db.url, { max: 1, onnotice: () => {} });
  try {
    const rows = await client<{ count: number }[]>`
      select count(*)::int as count from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema')`;
    return rows[0]?.count ?? 0;
  } finally {
    await client.end();
  }
}

async function save(): Promise<void> {
  const db = target();
  await waitUntilReady(db);
  mkdirSync(dirname(file), { recursive: true });
  const dump = inContainer(
    [
      "pg_dump",
      "-U",
      db.user,
      "-d",
      db.name,
      "--no-owner",
      "--no-privileges",
      "--exclude-schema=pgboss",
      ...withoutRows.map((table) => `--exclude-table-data=public.${table}`),
    ],
    "ignore",
  );
  if (!dump.stdout) throw new Error("pg_dump gave no output");
  await Promise.all([
    finished(dump, "pg_dump"),
    pipeline(dump.stdout, createGzip({ level: 9 }), createWriteStream(file)),
  ]);
  console.log(`Saved ${db.name} to ${file} (${(statSync(file).size / 1_048_576).toFixed(1)} MB)`);
}

async function restore(replace: boolean): Promise<void> {
  const db = target();
  if (!existsSync(file)) throw new Error(`There is no snapshot at ${file}`);
  await waitUntilReady(db);
  if (replace) await maintenance(db, `drop database if exists "${db.name}" with (force)`);
  await ensureDatabase(db.url);
  if ((await tableCount(db)) > 0) {
    throw new Error(
      `The database ${db.name} already has tables, so nothing was loaded. ` +
        "To replace it with the snapshot: pnpm db:restore --replace",
    );
  }

  const psql = inContainer(["psql", "-U", db.user, "-d", db.name, "-v", "ON_ERROR_STOP=1", "-q"], "pipe");
  psql.stdout?.resume();
  if (!psql.stdin) throw new Error("psql takes no input");
  await Promise.all([finished(psql, "psql"), pipeline(createReadStream(file), createGunzip(), psql.stdin)]);

  // The migrations added since the snapshot was saved.
  await migrateDatabase(db.url);
  console.log(`Restored the snapshot into ${db.name}. Next: pnpm db:seed, which creates the users and prints their API keys.`);
}

const [command, ...options] = process.argv.slice(2);
try {
  if (command === "save" && options.length === 0) await save();
  else if (command === "restore" && options.every((option) => option === "--replace")) await restore(options.length > 0);
  else {
    console.error("Usage: snapshot.ts save | restore [--replace]");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
