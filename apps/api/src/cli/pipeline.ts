import { createDb } from "@magic-events/db";
import { createLogger } from "../adapters/logging/pino.ts";
import { loadSettings } from "../adapters/settings/env.ts";
import { createServices } from "../app.ts";
import type { ProcessingOutcome } from "../core/data-processing/ports.ts";
import type { RunSummary } from "../core/discovery/ports.ts";

// Runs the pipeline once, by hand, without waiting for the schedule.
//
//   pnpm --filter @magic-events/api pipeline discover                fetch every active source now
//   pnpm --filter @magic-events/api pipeline discover --due          fetch only the sources that are due
//   pnpm --filter @magic-events/api pipeline discover --source NAME  fetch one source by its name
//   pnpm --filter @magic-events/api pipeline process [--limit N]     process pending raw listings
//   pnpm --filter @magic-events/api pipeline run                     discover, then process

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function printRuns(runs: RunSummary[]): void {
  if (runs.length === 0) {
    console.log("No source was fetched.");
    return;
  }
  for (const run of runs) {
    const counts =
      `${run.listingsFound} found, ${run.listingsNewOrChanged} new or changed, ` +
      `${run.listingsUnchanged} unchanged, ${run.listingsRemoved} removed`;
    console.log(
      run.status === "succeeded"
        ? `  ${run.sourceName}: ${counts}${run.complete ? "" : " (not a complete run)"}`
        : `  ${run.sourceName}: FAILED: ${run.error ?? "no error recorded"}`,
    );
  }
}

function printOutcomes(outcomes: ProcessingOutcome[]): void {
  if (outcomes.length === 0) {
    console.log("Nothing was pending.");
    return;
  }
  for (const one of outcomes) {
    console.log(
      one.outcome === "processed"
        ? `  ${one.sourceName} ${one.rawListingId}: ${one.experiences} experiences, ${one.created} new, ` +
            `${one.changed} changed, ${one.unlinked} unlinked`
        : `  ${one.sourceName} ${one.rawListingId}: FAILED: ${one.error ?? "no error recorded"}`,
    );
  }
  const failed = outcomes.filter((one) => one.outcome === "failed").length;
  const experiences = outcomes.reduce((total, one) => total + one.experiences, 0);
  const created = outcomes.reduce((total, one) => total + one.created, 0);
  console.log(
    `Processed ${outcomes.length - failed} raw listings and failed ${failed}: ${experiences} experiences, ${created} new.`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "discover" && command !== "process" && command !== "run") {
    throw new Error("Say what to run: discover, process or run.");
  }

  const settings = loadSettings();
  const logger = createLogger(settings.api);
  const { db, close } = createDb(settings.database.url, { max: 4 });
  try {
    const { discovery, dataProcessing } = createServices({ settings, db, logger });

    if (command === "discover" || command === "run") {
      const name = option("--source");
      let runs: RunSummary[];
      if (process.argv.includes("--due")) {
        runs = await discovery.runDueSources();
      } else {
        const sources = (await discovery.listSources()).filter((source) =>
          name === undefined ? source.active : source.name === name,
        );
        if (name !== undefined && sources.length === 0) throw new Error(`There is no source named "${name}".`);
        runs = [];
        for (const source of sources) runs.push(await discovery.runSource(source.id));
      }
      console.log("Discovery:");
      printRuns(runs);
    }

    if (command === "process" || command === "run") {
      const limit = option("--limit");
      const outcomes = await dataProcessing.processPending(limit === undefined ? {} : { limit: Number(limit) });
      console.log("Processing:");
      printOutcomes(outcomes);
    }
  } finally {
    await close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
