import { ensureDatabase, migrateDatabase } from "../migrate.ts";

// Creates the database if it is missing, then applies the migrations.
// Reads the URL from the variable named by the first argument, DATABASE_URL by default.
const variable = process.argv[2] ?? "DATABASE_URL";
const url = process.env[variable];
if (!url) {
  console.error(`${variable} is not set`);
  process.exit(1);
}

await ensureDatabase(url);
await migrateDatabase(url);
console.log(`Migrated the database in ${variable}`);
