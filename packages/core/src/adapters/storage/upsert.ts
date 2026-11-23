import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// The condition of an upsert's update: true when an incoming value differs from the stored one. With it, saving
// the values that are stored writes nothing, so the row and its updated_at stay as they are. Postgres still
// locks the stored row, and returns no row for it, so the caller reads it back.
export function differsFromStored(columns: AnyPgColumn[]): SQL {
  const stored = sql.join(
    columns.map((column) => sql`${column}`),
    sql`, `,
  );
  const incoming = sql.join(
    columns.map((column) => sql`excluded.${sql.identifier(column.name)}`),
    sql`, `,
  );
  return sql`(${stored}) is distinct from (${incoming})`;
}
