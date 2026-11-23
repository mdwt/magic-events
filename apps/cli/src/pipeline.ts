import { createDb } from "@magic-events/db";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { loadSettings } from "@magic-events/core/adapters/settings/env.ts";
import { createServices } from "@magic-events/core/services.ts";
import type { ProcessingOutcome } from "@magic-events/core/data-processing/ports.ts";
import type { RunSummary } from "@magic-events/core/discovery/ports.ts";

// Runs the pipeline once, by hand, without waiting for the schedule.
//
//   pnpm --filter @magic-events/api pipeline discover                fetch every active source now
//   pnpm --filter @magic-events/api pipeline discover --due          fetch only the sources that are due
//   pnpm --filter @magic-events/api pipeline discover --source NAME  fetch one source by its name
//   pnpm --filter @magic-events/api pipeline process [--limit N]     process pending raw listings
//   pnpm --filter @magic-events/api pipeline embed                   embed the experiences that need it
//   pnpm --filter @magic-events/api pipeline run                     discover, process, then embed
//
// Fetching again and processing again, on demand. Each takes exactly one selector.
//
//   pipeline refetch --location SLUG       fetch every active source of the location now
//   pipeline refetch --source NAME         fetch one source now
//   pipeline refetch --listing ID          fetch the source that listing belongs to
//   pipeline reprocess --listing ID        send one listing back for processing
//   pipeline reprocess --experience ID     send every listing an experience was built from back for processing
//                                          (ID is the experience's ID or its slug)
//   pipeline reprocess --source NAME       send every listing of a source back
//   pipeline reprocess --location SLUG     send every listing of a location back
//       add --now to process them straight away

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// The one selector a command is given, such as --source NAME. None, several, or one with no value is a usage error.
function selector<N extends string>(command: string, names: readonly N[]): { name: N; value: string } {
  const given = names.filter((name) => process.argv.includes(name));
  const [name] = given;
  if (given.length !== 1 || name === undefined) {
    throw new Error(`Say what to ${command} with exactly one of ${names.join(", ")}.`);
  }
  const value = option(name);
  if (value === undefined || value.startsWith("--")) throw new Error(`Give ${name} a value.`);
  return { name, value };
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
  if (
    command !== "discover" &&
    command !== "process" &&
    command !== "embed" &&
    command !== "run" &&
    command !== "refetch" &&
    command !== "reprocess"
  ) {
    throw new Error("Say what to run: discover, process, embed, run, refetch or reprocess.");
  }

  const settings = loadSettings();
  const logger = createLogger(settings.api);
  const { db, close } = createDb(settings.database.url, { max: 4 });
  try {
    const { catalogue, discovery, dataProcessing } = createServices({ settings, db, logger });

    if (command === "discover" || command === "run") {
      const name = option("--source");
      const sources = process.argv.includes("--due")
        ? await discovery.findDueSources()
        : (await discovery.listSources()).filter((source) =>
            name === undefined ? source.active : source.name === name,
          );
      if (name !== undefined && sources.length === 0) throw new Error(`There is no source named "${name}".`);
      const runs: RunSummary[] = [];
      for (const source of sources) runs.push(await discovery.runSource(source.id));
      console.log("Discovery:");
      printRuns(runs);
    }

    if (command === "process" || command === "run") {
      const limit = option("--limit");
      const outcomes = await dataProcessing.processPending(limit === undefined ? {} : { limit: Number(limit) });
      console.log("Processing:");
      printOutcomes(outcomes);
    }

    if (command === "embed" || command === "run") {
      // Round after round until none is left, or until a round in which the model failed on every text.
      let embedded = 0;
      let round = await catalogue.embedExperiences();
      embedded += round.embedded;
      while (round.remaining > 0 && !(round.embedded === 0 && round.failed > 0)) {
        round = await catalogue.embedExperiences();
        embedded += round.embedded;
      }
      console.log("Embedding:");
      console.log(`  Embedded ${embedded} experiences. ${round.failed} failed in the last round, ${round.remaining} remain.`);
    }

    if (command === "refetch") {
      const { name, value } = selector("refetch", ["--location", "--source", "--listing"] as const);
      let runs: RunSummary[] = [];
      if (name === "--location") {
        runs = await discovery.runLocation(value);
      } else if (name === "--source") {
        const sources = (await discovery.listSources()).filter((source) => source.name === value);
        if (sources.length === 0) throw new Error(`There is no source named "${value}".`);
        for (const source of sources) runs.push(await discovery.runSource(source.id));
      } else {
        // A listing is fetched with the rest of its source.
        const listing = await discovery.getListing(value);
        if (!listing) throw new Error(`There is no listing with the ID "${value}".`);
        console.log(`Listing ${listing.id} belongs to ${listing.sourceName}, which is fetched whole.`);
        runs = [await discovery.runSource(listing.sourceId)];
      }
      console.log("Discovery:");
      printRuns(runs);
    }

    if (command === "reprocess") {
      const { name, value } = selector("reprocess", ["--listing", "--experience", "--source", "--location"] as const);
      const result = await dataProcessing.reprocess(
        name === "--listing"
          ? { listingId: value }
          : name === "--experience"
            ? { experienceId: value }
            : name === "--source"
              ? { sourceName: value }
              : { locationSlug: value },
      );
      console.log(`Sent ${result.requeued} listings back for processing.`);
      if (process.argv.includes("--now")) {
        const outcomes = await dataProcessing.processPending();
        console.log("Processing:");
        printOutcomes(outcomes);
      }
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
