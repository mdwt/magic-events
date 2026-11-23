import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
// The first argument of db.transaction's callback. A repository takes Db | Tx so it runs inside or outside a transaction.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export * from "./schema/index.ts";
export { schema };
