import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDb } from "@magic-events/db";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { loadSettings } from "@magic-events/core/adapters/settings/env.ts";
import type { Settings } from "@magic-events/core/shared/settings.ts";
import { buildApp } from "./app.ts";

// Writes the OpenAPI document the server serves at GET /openapi.json to apps/api/openapi.json. With --check it writes
// nothing and fails when the file differs from the document, so CI catches a file that has fallen behind the routes.
// The app is built and made ready, but it does not listen and starts no jobs. The database is never queried, so none
// needs to be running.

export const DOCUMENT_PATH = fileURLToPath(new URL("../openapi.json", import.meta.url));
const SHOWN_PATH = "apps/api/openapi.json";

// The document, built from the route schemas exactly as the running server builds it.
export async function openApiDocument(settings: Settings) {
  const database = createDb(settings.database.url, { max: 1 });
  try {
    const logger = createLogger({ ...settings.api, logLevel: "silent", logPretty: false });
    const { app } = await buildApp({ settings, db: database.db, logger });
    try {
      await app.ready();
      return app.swagger();
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
  }
}

// The file's text: two-space JSON in the order the plugin gives, with a newline at the end.
export function openApiText(document: object): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const text = openApiText(await openApiDocument(settings));
  if (!check) {
    await writeFile(DOCUMENT_PATH, text);
    process.stdout.write(`Wrote ${SHOWN_PATH}\n`);
    return;
  }

  const onDisk = await readFile(DOCUMENT_PATH, "utf8").catch(() => undefined);
  if (onDisk === text) {
    process.stdout.write(`${SHOWN_PATH} is up to date\n`);
    return;
  }
  process.stderr.write(
    `${SHOWN_PATH} ${onDisk === undefined ? "does not exist" : "is out of date"}. ` +
      "Run pnpm openapi and commit the result.\n",
  );
  process.exitCode = 1;
}

if (import.meta.main) await main();
