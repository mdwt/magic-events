import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@magic-events/db";
import { z } from "zod";
import { createLanguageModel } from "@magic-events/core/adapters/language-model/anthropic.ts";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { loadSettings } from "@magic-events/core/adapters/settings/env.ts";
import { createServices } from "@magic-events/core/services.ts";
import { classificationAnswerSchema, type ClassificationAnswer } from "@magic-events/core/data-processing/classify.ts";
import { extractionAnswerSchema, type ExtractionAnswer } from "@magic-events/core/data-processing/extract.ts";
import { matchAnswerSchema, type MatchAnswer, normaliseTitle } from "@magic-events/core/data-processing/match.ts";
import type { ProcessingOutcome } from "@magic-events/core/data-processing/ports.ts";
import type { FetchedListing, SaveSourceInput, SourceFetcher } from "@magic-events/core/discovery/ports.ts";
import { type LanguageModel, LanguageModelFailed, type LanguageModelRequest } from "@magic-events/core/shared/language-model.ts";

// Loads pages captured by a browser scrape through the pipeline, as if the sources had just been fetched.
//
//   pnpm cli:captures                    load every source in data/hermanus/sources.json
//   pnpm cli:captures -- --source SLUG   load one source by its slug
//   pnpm cli:captures -- --no-model      never ask the language model, even for an unsure match
//
// A capture directory holds sources.json, raw/<slug>/ with one file per captured page (its first line is
// "URL: <address>"), and extracted/<slug>.json with the experiences read from those pages.
// For each source the script saves the source row, then runs it through Discovery with the captures standing in
// for the fetch adapter, and processes the raw listings through Data processing with the captured experiences
// standing in for the language model's extraction and classification. Everything else is the pipeline's own:
// runs, listings, fingerprints, the checks on what was extracted, seasons, matching, precedence and saving.
// Running it again saves nothing new for a capture that has not changed.

// ---- The capture files ----

const text = z.string().nullish();

const attributeValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);

// How premium the experience is, read one by one from each capture. A capture without one gets the attribute's
// default when it is classified.
const tier = z.enum(["luxury", "premium", "standard", "everyday"]);

const capturedExperienceSchema = z.object({
  rawFile: z.string(),
  url: text,
  title: z.string(),
  summary: text,
  description: text,
  type: z.enum(["single", "run", "recurring"]),
  status: z.enum(["expected", "announced", "confirmed", "postponed", "cancelled"]),
  booking: z.enum(["none", "not_yet", "open", "sold_out", "closed"]),
  sessions: z
    .array(
      z.object({
        start: z.string(),
        end: text,
        precision: z.enum(["day", "month", "year"]),
        startTime: text,
        endTime: text,
        label: text,
        soldOut: z.boolean().nullish(),
        cancelled: z.boolean().nullish(),
      }),
    )
    .default([]),
  recurrence: z
    .object({
      rule: z.string(),
      start: z.string(),
      end: text,
      startTime: text,
      endTime: text,
      skipped: z.array(z.string()).nullish(),
    })
    .nullish(),
  openingHours: text,
  venue: z
    .object({ name: text, address: text, city: text, position: z.object({ lat: z.number(), lng: z.number() }).nullish() })
    .nullish(),
  price: z.object({ min: z.number().nullish(), max: z.number().nullish(), currency: text }).nullish(),
  onSaleAt: text,
  bookingClosesAt: text,
  bookingUrl: text,
  imageUrl: text,
  hints: z.array(z.string()).nullish(),
  attributes: z.object({ tier: tier.optional() }).catchall(attributeValue).nullish(),
  tags: z.array(z.string()).nullish(),
  profile: text,
});
type CapturedExperience = z.infer<typeof capturedExperienceSchema>;

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
      // Page addresses of the source that have no capture, such as a search page that listed nothing.
      urls: z.array(z.url()).default([]),
      // Captures that are not loaded, such as a PDF calendar that a seeded source already fetches.
      skipFiles: z.array(z.string()).default([]),
    }),
  ),
});

// One captured page or file, as a fetch adapter would return it, with the experiences read from it.
interface Capture {
  listing: FetchedListing;
  experiences: CapturedExperience[];
}

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
        input: { ...common, name: entry.name, kind: "web_page", settings: { urls } },
        captures: [...pages.values()],
      });
    }
  }
  return { sources, notes };
}

// ---- The captured experiences, as the answers the pipeline expects ----

type AnswerExperience = ExtractionAnswer["experiences"][number];

function extractionAnswer(experience: CapturedExperience): AnswerExperience {
  const { recurrence } = experience;
  return {
    title: experience.title,
    summary: experience.summary ?? "",
    description: experience.description ?? "",
    type: experience.type,
    status: experience.status,
    booking: experience.booking,
    sessions: experience.sessions.map((session) => ({
      start: session.start,
      end: session.end ?? "",
      precision: session.precision,
      startTime: session.startTime ?? "",
      endTime: session.endTime ?? "",
      label: session.label ?? "",
      soldOut: session.soldOut ?? false,
      cancelled: session.cancelled ?? false,
    })),
    recurrence: recurrence
      ? {
          rule: recurrence.rule,
          start: recurrence.start,
          end: recurrence.end ?? "",
          startTime: recurrence.startTime ?? "",
          endTime: recurrence.endTime ?? "",
          skipped: recurrence.skipped ?? [],
        }
      : null,
    openingHours: experience.openingHours ?? "",
    venueName: experience.venue?.name ?? "",
    venueAddress: experience.venue?.address ?? "",
    city: experience.venue?.city ?? "",
    venueLatitude: experience.venue?.position?.lat ?? null,
    venueLongitude: experience.venue?.position?.lng ?? null,
    priceMin: experience.price?.min ?? null,
    priceMax: experience.price?.max ?? null,
    currency: experience.price?.currency ?? "",
    onSaleAt: experience.onSaleAt ?? "",
    bookingClosesAt: experience.bookingClosesAt ?? "",
    bookingUrl: experience.bookingUrl ?? "",
    imageUrl: experience.imageUrl ?? "",
    url: experience.url ?? "",
    hints: experience.hints ?? [],
  };
}

function classificationAnswer(experience: CapturedExperience): ClassificationAnswer {
  return {
    attributes: Object.entries(experience.attributes ?? {}).map(([key, value]) => ({
      key,
      values: (Array.isArray(value) ? value : [value]).map(String),
    })),
    tags: experience.tags ?? [],
    profile: experience.profile ?? "",
  };
}

// ---- Matching without the model, when it is plain ----

// Words that say nothing about which experience a title names.
const WEAK_WORDS = new Set(
  ("hermanus live at in the and of with presents present show concert by on for to a an die en se van op by n " +
    "tribute experience event events").split(" "),
);

function strongWords(value: string): Set<string> {
  return new Set(
    normaliseTitle(value)
      .split(" ")
      .filter((word) => word.length > 1 && !WEAK_WORDS.has(word) && !/^\d+$/.test(word)),
  );
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

interface MatchQuestion {
  title: string;
  place: string;
  start: string;
  recurring: boolean;
  candidates: { id: string; title: string; place: string; first: string; recurring: boolean }[];
}

// The question as Data processing writes it (matchText in match.ts), read back.
function readMatchQuestion(question: string): MatchQuestion | undefined {
  const title = /^Title: (.*)$/m.exec(question)?.[1];
  const place = /^Venue: (.*)$/m.exec(question)?.[1];
  const dates = /^Dates: (\S+) to (\S+?)(, repeating .*)?$/m.exec(question);
  if (title === undefined || place === undefined || !dates) return undefined;
  const candidates = [...question.matchAll(/^- ID (\S+): (.*); venue: (.*); dates: (\S+) to (\S+?)(, repeating .*)?$/gm)].map(
    (found) => ({
      id: found[1] ?? "",
      title: found[2] ?? "",
      place: found[3] ?? "",
      first: found[4] ?? "",
      recurring: found[6] !== undefined,
    }),
  );
  return { title, place, start: dates[1] ?? "", recurring: dates[3] !== undefined, candidates };
}

// "sure" with the candidate it is, "unsure" when a candidate might be it, "none" when no candidate comes close.
// When it is not sure it never merges: a second copy of an experience is easier to mend than two made one.
function matchPlainly(question: MatchQuestion): { verdict: "sure"; id: string } | { verdict: "unsure" | "none" } {
  const words = strongWords(question.title);
  const place = strongWords(question.place);
  let best: { id: string; shared: number } | undefined;
  let unsure = false;
  for (const candidate of question.candidates) {
    const theirs = strongWords(candidate.title);
    const smaller = Math.min(words.size, theirs.size);
    if (smaller === 0) continue;
    const shared = sharedCount(words, theirs);
    const cover = shared / smaller;
    const theirPlace = strongWords(candidate.place);
    const samePlace = sharedCount(place, theirPlace) > 0;
    const placesDiffer = place.size > 0 && theirPlace.size > 0 && !samePlace;
    const sameKind = question.recurring === candidate.recurring;
    const sameStart = question.start === candidate.first;

    const sure =
      sameKind && !placesDiffer && ((cover >= 0.8 && shared >= 2) || (cover === 1 && sameStart && samePlace));
    if (sure) {
      if (!best || shared > best.shared) best = { id: candidate.id, shared };
    } else if (shared >= 1 && cover >= 0.5 && (sameStart || (question.recurring && candidate.recurring))) {
      unsure = true;
    }
  }
  if (best) return { verdict: "sure", id: best.id };
  return { verdict: unsure ? "unsure" : "none" };
}

// ---- The language model that answers from the captures ----

class CaptureModel implements LanguageModel {
  readonly #real: LanguageModel | undefined;
  #captures = new Map<string, CapturedExperience[]>();
  // The experiences of the listing being processed, whose classifications are asked for next.
  #current: CapturedExperience[] = [];
  // False while a raw listing with no capture is processed: every question about it goes to the real model.
  #replaying = false;
  readonly counts = { matchedPlainly: 0, askedModel: 0, modelFailed: 0, leftUnmatched: 0 };

  constructor(real: LanguageModel | undefined) {
    this.#real = real;
  }

  load(captures: Capture[]): void {
    this.#captures = new Map(
      captures.flatMap((capture) => (capture.listing.url === undefined ? [] : [[capture.listing.url, capture.experiences]])),
    );
    this.#current = [];
  }

  async ask<T>(request: LanguageModelRequest<T>): Promise<T> {
    const schema: unknown = request.schema;

    if (schema === extractionAnswerSchema) {
      const url = /^The item is [^\n]*?, at (\S+)\.$/m.exec(request.text)?.[1];
      const captured = url === undefined ? undefined : this.#captures.get(url);
      this.#replaying = captured !== undefined;
      this.#current = [];
      if (captured) {
        this.#current = [...captured];
        const answer: ExtractionAnswer = { experiences: captured.map(extractionAnswer) };
        return request.schema.parse(answer);
      }
    }

    if (schema === classificationAnswerSchema) {
      const title = /^Title: (.*)$/m.exec(request.text)?.[1];
      const index = this.#current.findIndex((experience) => experience.title.trim() === title);
      const captured = this.#current[index];
      if (captured) {
        // Taken out, so a second experience with the same title on the page gets its own.
        this.#current.splice(index, 1);
        return request.schema.parse(classificationAnswer(captured));
      }
    }

    if (schema === matchAnswerSchema && this.#replaying) {
      const none: MatchAnswer = { experienceId: "" };
      const question = readMatchQuestion(request.text);
      const plain = question ? matchPlainly(question) : { verdict: "unsure" as const };
      if (plain.verdict === "sure") {
        this.counts.matchedPlainly += 1;
        const answer: MatchAnswer = { experienceId: plain.id };
        return request.schema.parse(answer);
      }
      if (plain.verdict === "none") return request.schema.parse(none);
      if (!this.#real) {
        this.counts.leftUnmatched += 1;
        return request.schema.parse(none);
      }
      this.counts.askedModel += 1;
      try {
        return await this.#real.ask(request);
      } catch (error) {
        if (!(error instanceof LanguageModelFailed)) throw error;
        this.counts.modelFailed += 1;
        return request.schema.parse(none);
      }
    }

    // A raw listing with no capture, which the pipeline's own fetch left pending: it is processed the real way.
    if (!this.#real) throw new LanguageModelFailed("unavailable", "No capture answers this, and the model is off.");
    return this.#real.ask(request);
  }
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
  // The pipeline logs every saved experience. A load of hundreds prints its own summary instead.
  const logger = createLogger({ ...settings.api, logLevel: "warn" });
  const { db, close } = createDb(settings.database.url, { max: 4 });
  try {
    const staged: { listings: FetchedListing[] } = { listings: [] };
    const fetchers: SourceFetcher[] = [
      { kind: "web_page", fetch: () => Promise.resolve({ listings: staged.listings, complete: true, syncState: {} }) },
    ];
    const model = new CaptureModel(
      process.argv.includes("--no-model") ? undefined : createLanguageModel(settings.languageModel, logger),
    );
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
