import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createDb, schema } from "@magic-events/db";
import { getAuthTables } from "better-auth/db";
import { getTableColumns, getTableName, is, Table, type Column } from "drizzle-orm";
import { createAuth } from "../src/adapters/auth/better-auth.ts";
import { testSettings } from "./helpers/harness.ts";

// The Better Auth tables in packages/db were written by hand. This checks them against the tables Better Auth and
// its API key plugin say they need, with the options the app uses. No database is reached.

const url = "postgres://nobody@localhost:1/none";
const database = createDb(url, { max: 1 });
after(() => database.close());

const auth = createAuth(database.db, testSettings(url).identity);

// Better Auth's field types and the Drizzle column types that hold them.
const COLUMN_TYPES: Record<string, string[]> = {
  string: ["PgText", "PgUUID", "PgEnumColumn", "PgVarchar"],
  number: ["PgInteger", "PgBigInt53", "PgDoublePrecision", "PgNumeric"],
  boolean: ["PgBoolean"],
  date: ["PgTimestamp"],
  json: ["PgJsonb", "PgJson"],
};

function drizzleTable(name: string): Table | undefined {
  for (const value of Object.values(schema)) {
    if (is(value, Table) && getTableName(value) === name) return value;
  }
  return undefined;
}

const tables = getAuthTables(auth.options);

for (const [key, definition] of Object.entries(tables)) {
  const model = definition.modelName;

  test(`the ${model} table has every field Better Auth writes, with a fitting type`, () => {
    const table = drizzleTable(model);
    assert.ok(table, `there is no table named ${model}`);
    const columns: Record<string, Column | undefined> = getTableColumns(table);
    for (const [fieldKey, field] of Object.entries(definition.fields)) {
      const name = field.fieldName ?? fieldKey;
      const column = columns[name];
      assert.ok(column, `${model}.${name} is missing`);
      const type = Array.isArray(field.type) ? "string" : field.type;
      assert.ok(
        COLUMN_TYPES[type]?.includes(column.columnType),
        `${model}.${name} is ${column.columnType}, and Better Auth stores a ${type}`,
      );
      if (field.required === true) {
        assert.ok(column.notNull || column.hasDefault, `${model}.${name} is required by Better Auth but nullable`);
      }
    }
    assert.ok(columns.id, `${model}.id is missing`);
  });

  test(`the ${model} table has no required column Better Auth leaves empty`, () => {
    const table = drizzleTable(model);
    assert.ok(table);
    const known = new Set(["id", ...Object.entries(definition.fields).map(([fieldKey, f]) => f.fieldName ?? fieldKey)]);
    for (const [name, column] of Object.entries(getTableColumns(table))) {
      if (known.has(name)) continue;
      assert.ok(!column.notNull || column.hasDefault, `${model}.${name} is required, and Better Auth never writes it`);
    }
  });

  test(`the ${key} model is passed to the adapter under its own name`, () => {
    assert.equal(model, key);
  });
}
