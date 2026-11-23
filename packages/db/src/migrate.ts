import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// Creates the database the URL names if the server does not have it yet.
export async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Not a usable database name: ${name}`);

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const client = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  try {
    const found = await client`select 1 from pg_database where datname = ${name}`;
    if (found.length === 0) await client.unsafe(`create database "${name}"`);
  } finally {
    await client.end();
  }
}

// Applies every migration that the database has not had yet.
export async function migrateDatabase(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.end();
  }
}
