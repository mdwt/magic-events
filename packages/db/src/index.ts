import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    // JIT compilation off for every connection. Search and changed-since check each candidate in correlated
    // subqueries, so the planner's cost estimate passes jit_above_cost while the query itself takes milliseconds;
    // compiling it then cost about 200 ms a query, ten times the query (measured in packages/db/perf).
    connection: { jit: "off" },
  });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
// The first argument of db.transaction's callback. A repository takes Db | Tx so it runs inside or outside a transaction.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export * from "./schema/index.ts";
export { schema };
