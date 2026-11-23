import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@magic-events/db";
import { z } from "zod";
import { createLanguageModel } from "@magic-events/core/adapters/language-model/anthropic.ts";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { loadSettings } from "@magic-events/core/adapters/settings/env.ts";
import { createServices } from "@magic-events/core/services.ts";
import type { ProcessingOutcome } from "@magic-events/core/data-processing/ports.ts";
import type { FetchedListing, SaveSourceInput, SourceFetcher } from "@magic-events/core/discovery/ports.ts";
import { capturedExperienceSchema, CaptureModel, type Capture, type CapturedExperience } from "./capture-model.ts";

// Loads pages captured by a browser scrape through the pipeline, as if the sources had just been fetched.
//
//   pnpm cli:captures                    load every source in data/hermanus/sources.json
//   pnpm cli:captures --source SLUG   load one source by its slug
//   pnpm cli:captures --no-model      never ask the language model: an unsure match is left as two experiences
//
// A capture directory holds sources.json, raw/<slug>/ with one file per captured page (its first line is
// "URL: <address>"), and extracted/<slug>.json with the experiences read from those pages.
// For each source the script saves the source row, then runs it through Discovery with the captures standing in
// for the fetch adapter, and processes the raw listings through Data processing with the captured experiences
// standing in for the language model's extraction and classification. Everything else is the pipeline's own:
// runs, listings, fingerprints, the checks on what was extracted, seasons, matching, precedence and saving.
// Running it again saves nothing new for a capture that has not changed.

// ---- The manifest ----

const manifestSchema = z.object({
  locationSlug: z.string(),
  // Slugs that are captured but not loaded, such as a second capture of a site that is already a source.
  skip: z.array(z.string()).default([]),
  sources: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      priority: z.number().int(),
      // False for a site a plain fetch cannot read, so the schedule leaves it alone.
      active: z.boolean(),
      // True when the source's pages are an organiser's own, about its own offerings: each page is then the page
      // address of every experience on it that has none more specific.
      ownPages: z.boolean().default(false),
      // Page addresses of the source that have no capture, such as a search page that listed nothing.
      urls: z.array(z.url()).default([]),
      // Captures that are not loaded, such as a PDF calendar that a seeded source already fetches.
      skipFiles: z.array(z.string()).default([]),
    }),
  ),
});

interface SourceToLoad {
  slug: string;
  input: SaveSourceInput;
  captures: Capture[];
}

function readSources(dir: string, only: string | undefined): { sources: SourceToLoad[]; notes: string[] } {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")));
  const notes: string[] = [];
  const known = new Set([...manifest.sources.map((source) => source.slug), ...manifest.skip]);
  for (const slug of existsSync(join(dir, "raw")) ? readdirSync(join(dir, "raw")) : []) {
    if (!known.has(slug)) notes.push(`raw/${slug} is not in sources.json, so it was not loaded.`);
  }

  const sources: SourceToLoad[] = [];
  for (const entry of manifest.sources) {
    if (only !== undefined && entry.slug !== only) continue;

    const extractedPath = join(dir, "extracted", `${entry.slug}.json`);
    const experiences = existsSync(extractedPath)
      ? z.array(capturedExperienceSchema).parse(JSON.parse(readFileSync(extractedPath, "utf8")))
      : [];
    const byFile = new Map<string, CapturedExperience[]>();
    for (const experience of experiences) {
      byFile.set(experience.rawFile, [...(byFile.get(experience.rawFile) ?? []), experience]);
    }
    const common = { locationSlug: manifest.locationSlug, priority: entry.priority, active: entry.active };

    for (const file of entry.skipFiles) byFile.delete(file);

    // The captured pages, one listing per address. A file whose name starts with "_" is a note, not a page.
    const pages = new Map<string, Capture>();
    const rawDir = join(dir, "raw", entry.slug);
    for (const file of existsSync(rawDir) ? readdirSync(rawDir).sort() : []) {
      if (!file.endsWith(".txt") || file.startsWith("_")) continue;
      const rawFile = `raw/${entry.slug}/${file}`;
      const content = readFileSync(join(dir, rawFile), "utf8");
      const url = /^URL:\s*(\S+)/.exec(content)?.[1];
      if (url === undefined || !z.url().safeParse(url).success) {
        notes.push(`${rawFile} does not start with "URL: <address>", so it was not loaded.`);
        continue;
      }
      const found = byFile.get(rawFile) ?? [];
      byFile.delete(rawFile);
      // The fingerprint leaves out the address and the time the page was read, so a page captured again unchanged
      // keeps its fingerprint.
      const fingerprintOf = content.replace(/^URL:[^\n]*\n(Fetched:[^\n]*\n)?/, "");
      const listing: FetchedListing = { sourceListingId: url, url, contentType: "text/plain", content, fingerprintOf };
      const page = pages.get(url);
      if (page) page.experiences.push(...found);
      else pages.set(url, { listing, experiences: found });
    }
    for (const [rawFile, lost] of byFile) {
      notes.push(`${entry.slug}: ${lost.length} experiences name ${rawFile}, which is not a captured page.`);
    }

    const urls = [...new Set([...pages.keys(), ...entry.urls])];
    if (urls.length > 0) {
      sources.push({
        slug: entry.slug,
        input: {
          ...common,
          name: entry.name,
          kind: "web_page",
          settings: { urls, ...(entry.ownPages ? { ownPages: true } : {}) },
        },
        captures: [...pages.values()],
      });
    }
  }
  return { sources, notes };
}

// ---- The run ----

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sum(outcomes: ProcessingOutcome[], pick: (outcome: ProcessingOutcome) => number): number {
  return outcomes.reduce((total, outcome) => total + pick(outcome), 0);
}

async function main(): Promise<void> {
  const dir = option("--dir") ?? fileURLToPath(new URL("../../../data/hermanus", import.meta.url));
  const { sources, notes } = readSources(dir, option("--source"));
  if (sources.length === 0) throw new Error("No source to load. Check the slug and sources.json.");

  const settings = loadSettings();
  // The pipeline logs every saved experience. A load of hundreds prints its own summary instead, unless LOG_LEVEL asks
  // for debug or trace, so a load can be followed line by line.
  const traced = settings.api.logLevel === "debug" || settings.api.logLevel === "trace";
  const logger = createLogger(traced ? settings.api : { ...settings.api, logLevel: "warn" });
  const { db, close } = createDb(settings.database.url, { max: 4 });
  try {
    const staged: { listings: FetchedListing[] } = { listings: [] };
    const fetchers: SourceFetcher[] = [
      { kind: "web_page", fetch: () => Promise.resolve({ listings: staged.listings, complete: true, syncState: {} }) },
    ];
    const model = new CaptureModel(
      process.argv.includes("--no-model") ? undefined : createLanguageModel(settings.languageModel, logger),
    );
    // Every source's captures, so a pending raw listing of a source other than the one being loaded is answered
    // from its own capture.
    model.loadAll(readSources(dir, undefined).sources.flatMap((one) => one.captures));
    const { discovery, dataProcessing } = createServices({
      settings,
      db,
      logger,
      overrides: { fetchers, languageModel: model },
    });

    const totals = { listings: 0, captured: 0, saved: 0, created: 0, changed: 0, failed: 0 };
    for (const one of sources) {
      staged.listings = one.captures.map((capture) => capture.listing);
      model.load(one.captures);
      const captured = one.captures.reduce((total, capture) => total + capture.experiences.length, 0);

      const source = await discovery.saveSource(one.input);
      const run = await discovery.runSource(source.id);
      if (run.status === "failed") {
        console.log(`  ${source.name}: the run FAILED: ${run.error ?? "no error recorded"}`);
        totals.failed += 1;
        continue;
      }
      const outcomes = await dataProcessing.processPending();
      const failed = outcomes.filter((outcome) => outcome.outcome === "failed");
      const saved = sum(outcomes, (outcome) => outcome.experiences);
      const created = sum(outcomes, (outcome) => outcome.created);
      const changed = sum(outcomes, (outcome) => outcome.changed);
      console.log(
        `  ${source.name} (${source.kind}${source.active ? "" : ", inactive"}): ${run.listingsFound} listings, ` +
          `${run.listingsNewOrChanged} new or changed; ${captured} experiences captured, ${saved} saved, ` +
          `${created} new, ${changed} changed`,
      );
      for (const outcome of failed) console.log(`    FAILED ${outcome.rawListingId}: ${outcome.error ?? ""}`);

      totals.listings += run.listingsFound;
      totals.captured += captured;
      totals.saved += saved;
      totals.created += created;
      totals.changed += changed;
      totals.failed += failed.length;
    }

    console.log(
      `\n${sources.length} sources, ${totals.listings} listings, ${totals.captured} experiences captured: ` +
        `${totals.saved} saved, ${totals.created} new, ${totals.changed} changed, ${totals.failed} failed.`,
    );
    console.log(
      `Matches: ${model.counts.matchedPlainly} plain, ${model.counts.askedModel} asked of the model ` +
        `(${model.counts.modelFailed} unanswered), ${model.counts.leftUnmatched} left unmatched with the model off.`,
    );
    for (const { title, matched } of model.plainMatches) console.log(`  Matched plainly: "${title}" is "${matched}"`);
    for (const note of notes) console.log(`Note: ${note}`);
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
