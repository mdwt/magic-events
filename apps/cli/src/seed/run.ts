import { createDb } from "@magic-events/db";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { loadSettings } from "@magic-events/core/adapters/settings/env.ts";
import { createServices } from "@magic-events/core/services.ts";
import { seedDefaults, seedSamples, type IssuedKey } from "./seed.ts";

// Seeds the default data: pnpm --filter @magic-events/api seed
// With --samples it also inserts the sample experiences: pnpm --filter @magic-events/api seed:samples

function printKeys(issued: IssuedKey[]): void {
  if (issued.length === 0) {
    console.log("No new API keys: every seeded user already has its keys.");
    return;
  }
  const rule = "=".repeat(78);
  console.log(`\n${rule}\nNEW API KEYS, SHOWN ONCE. They are stored only as a hash and cannot be shown again.`);
  console.log(rule);
  for (const one of issued) {
    console.log(`${one.userName} <${one.email}>, ${one.kind} key "${one.credentialName}"\n  ${one.key}\n`);
  }
  console.log(`${rule}\n`);
}

async function main(): Promise<void> {
  const withSamples = process.argv.includes("--samples");
  const settings = loadSettings();
  const logger = createLogger(settings.api);
  const { db, close } = createDb(settings.database.url, { max: 1 });
  try {
    const services = createServices({ settings, db, logger });

    const seeded = await seedDefaults(services);
    console.log(
      `Default data seeded: Hermanus, ${seeded.attributes} attributes, ${seeded.tags} tags, ` +
        `${seeded.seasons} seasons, ${seeded.sources} sources, ${seeded.tenants} tenants, ${seeded.users} users.`,
    );
    printKeys(seeded.issued);

    if (withSamples) {
      const samples = await seedSamples(services, db);
      console.log(
        `Sample experiences: ${samples.inserted.length} inserted, ${samples.skipped.length} already there.`,
      );
    }
  } finally {
    await close();
  }
}

// An error's message, with its code when it has one: a refused connection has a code and an empty message.
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return [code, error.message].filter((part) => part.length > 0).join(": ");
}

main().catch((error: unknown) => {
  console.error(`Seeding failed: ${describe(error)}`);
  // A failed query wraps what went wrong, such as a refused connection, so the causes are printed too.
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    console.error(`Caused by: ${describe(cause)}`);
  }
  if (cause instanceof Error && cause.stack) console.error(cause.stack);
  process.exitCode = 1;
});
