import type {
  Catalogue,
  ExperienceMatch,
  Location,
  SaveExperienceInput,
  SaveExperienceResult,
} from "../catalogue/ports.ts";
import type { ClaimedRawListing, Discovery, RequeueResult } from "../discovery/ports.ts";
import type { Clock } from "../shared/clock.ts";
import { AppError, type ErrorDetail } from "../shared/errors.ts";
import { type LanguageModel, LanguageModelFailed } from "../shared/language-model.ts";
import type { Logger } from "../shared/logger.ts";
import type { ProcessingSettings } from "../shared/settings.ts";
import type { Transactions } from "../shared/transactions.ts";
import {
  checkClassification,
  classificationAnswerSchema,
  classificationInstructions,
  classificationText,
  type Definitions,
  seasonItIs,
  seasonsOf,
} from "./classify.ts";
import { isIsoDate } from "./dates.ts";
import {
  createExtractors,
  type ExtractedExperience,
  type Extractor,
  experienceSpan,
  sourcingWindow,
  UnreadableListing,
} from "./extract.ts";
import { MATCH_INSTRUCTIONS } from "./instructions.ts";
import {
  isFinal,
  matchAnswerSchema,
  matchInCode,
  matchLinked,
  matchText,
  nearDates,
  onlyMonthOrYear,
  pickedCandidate,
  precedenceOf,
  type Span,
} from "./match.ts";
import type {
  AttributeDefinition,
  DataProcessing,
  DataProcessingRepository,
  ProcessingOutcome,
  ReprocessTarget,
  SaveSeasonInput,
  Season,
  TagDefinition,
  UndefinedValueRow,
  WarehouseRow,
} from "./ports.ts";

// Why the attribute's default value does not fit it, or null when it fits.
function defaultValueProblem(input: AttributeDefinition): string | null {
  const value = input.defaultValue;
  if (value === null) return null;
  switch (input.type) {
    case "option":
      if (typeof value !== "string") return "Must be the key of one of the attribute's options.";
      return input.options.some((option) => option.key === value) ? null : `"${value}" is not one of the options.`;
    case "text":
      return typeof value === "string" ? null : "Must be text.";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "Must be a number.";
    case "boolean":
      return typeof value === "boolean" ? null : "Must be true or false.";
    case "date":
      return typeof value === "string" && isIsoDate(value) ? null : "Must be a date as YYYY-MM-DD.";
  }
}

// The shape of an ID, which tells an experience's ID from its slug.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The longest error text kept on a failed raw listing.
const ERROR_TEXT_LIMIT = 1000;

// A short text for the raw listing's error, saying what failed.
function errorText(error: unknown): string {
  let text: string;
  if (error instanceof LanguageModelFailed) text = `The language model failed (${error.reason}): ${error.message}`;
  else if (error instanceof AppError) text = `${error.code}: ${error.message}`;
  else if (error instanceof Error) text = error.message;
  else text = String(error);
  return text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT - 1)}…` : text;
}

// A failure that comes from the raw listing or the model's answer, not from the system.
function isInputFailure(error: unknown): boolean {
  return (
    error instanceof LanguageModelFailed ||
    error instanceof UnreadableListing ||
    (error instanceof AppError && error.code === "invalid_input")
  );
}

// The experience's dates as one span, an open-ended one running to the horizon.
function spanOf(experience: ExtractedExperience, horizonEnd: string): Span {
  const { first, last } = experienceSpan(experience);
  return { start: first, end: last ?? horizonEnd };
}

// The extracted experience, as Catalogue saves it.
function saveInput(input: {
  experience: ExtractedExperience;
  location: Location;
  raw: ClaimedRawListing;
  match: ExperienceMatch | undefined;
  precedence: "lead" | "fill";
  attributes: SaveExperienceInput["attributes"];
  tags: string[];
  profile: string | undefined;
}): SaveExperienceInput {
  const { experience } = input;
  return {
    ...(input.match ? { experienceId: input.match.id } : {}),
    locationId: input.location.id,
    title: experience.title,
    summary: experience.summary,
    description: experience.description,
    profile: input.profile,
    type: experience.type,
    status: experience.status,
    booking: experience.booking,
    openingHours: experience.openingHours,
    venue: experience.venue,
    price: experience.price,
    onSaleAt: experience.onSaleAt,
    bookingClosesAt: experience.bookingClosesAt,
    bookingUrl: experience.bookingUrl,
    imageUrl: experience.imageUrl,
    pageUrl: experience.url,
    sessions: experience.sessions.map((session) => ({
      startDate: session.start,
      endDate: session.end,
      precision: session.precision,
      startTime: session.startTime,
      endTime: session.endTime,
      label: session.label,
      soldOut: session.soldOut,
      cancelled: session.cancelled,
    })),
    recurrence: experience.recurrence,
    attributes: input.attributes,
    tags: input.tags,
    source: { listingId: input.raw.listingId, rawListingId: input.raw.id },
    precedence: input.precedence,
  };
}

function outcomeOf(
  raw: ClaimedRawListing,
  counts: Pick<ProcessingOutcome, "experiences" | "created" | "changed" | "unlinked">,
): ProcessingOutcome {
  return {
    rawListingId: raw.id,
    listingId: raw.listingId,
    sourceName: raw.source.name,
    outcome: "processed",
    ...counts,
    error: null,
  };
}

export class DataProcessingService implements DataProcessing {
  readonly #repository: DataProcessingRepository;
  readonly #catalogue: Catalogue;
  readonly #discovery: Discovery;
  readonly #languageModel: LanguageModel;
  readonly #transactions: Transactions;
  readonly #settings: ProcessingSettings;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #extractors: Map<string, Extractor>;

  constructor(deps: {
    repository: DataProcessingRepository;
    catalogue: Catalogue;
    discovery: Discovery;
    languageModel: LanguageModel;
    transactions: Transactions;
    settings: ProcessingSettings;
    logger: Logger;
    clock?: Clock;
  }) {
    this.#repository = deps.repository;
    this.#catalogue = deps.catalogue;
    this.#discovery = deps.discovery;
    this.#languageModel = deps.languageModel;
    this.#transactions = deps.transactions;
    this.#settings = deps.settings;
    this.#logger = deps.logger.child({ domain: "data-processing" });
    this.#clock = deps.clock ?? (() => new Date());
    this.#extractors = createExtractors({
      languageModel: deps.languageModel,
      horizonMonths: deps.settings.horizonMonths,
      logger: this.#logger,
    });
  }

  async processNext(): Promise<ProcessingOutcome | null> {
    // The claim locks the raw listing until the transaction ends. The work runs in a savepoint, so a failure rolls
    // back only the work and is marked while the lock is held: no other worker can claim the raw listing before
    // its attempt is counted. A failure of the claim or of the mark rolls back everything and is thrown on.
    return this.#transactions.run(async () => {
      const raw = await this.#discovery.claimPendingRawListing();
      if (raw === null) return null;
      try {
        return await this.#transactions.run(() => this.#process(raw));
      } catch (error) {
        return this.#fail(raw, error);
      }
    });
  }

  async processPending(options: { limit?: number } = {}): Promise<ProcessingOutcome[]> {
    const outcomes: ProcessingOutcome[] = [];
    while (options.limit === undefined || outcomes.length < options.limit) {
      const outcome = await this.processNext();
      if (outcome === null) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async reprocess(target: ReprocessTarget): Promise<RequeueResult> {
    let result: RequeueResult;
    if ("listingId" in target) {
      result = await this.#discovery.requeueListings({ listingIds: [target.listingId] });
    } else if ("experienceId" in target) {
      // An experience is named by its ID or by its slug, and a slug is never a UUID.
      const name = target.experienceId;
      const found = await this.#catalogue.getExperience(UUID.test(name) ? { id: name } : { slug: name });
      if (!found) throw new AppError("not_found", `No experience with the ID or slug "${name}".`);
      if (found.listingIds.length === 0) {
        throw new AppError(
          "invalid_input",
          `The experience "${found.slug}" is linked to no listing, so there is nothing to process again.`,
        );
      }
      result = await this.#discovery.requeueListings({ listingIds: found.listingIds });
    } else if ("sourceName" in target) {
      // A name is unique within a location, so one name can be a source in each of several locations.
      const sources = (await this.#discovery.listSources()).filter((source) => source.name === target.sourceName);
      if (sources.length === 0) throw new AppError("not_found", `No source named "${target.sourceName}".`);
      const listingIds: string[] = [];
      for (const source of sources) {
        listingIds.push(...(await this.#discovery.requeueListings({ sourceId: source.id })).listingIds);
      }
      result = { requeued: listingIds.length, listingIds };
    } else {
      const location = await this.#catalogue.getLocation({ slug: target.locationSlug });
      if (!location) throw new AppError("not_found", `No location with the slug "${target.locationSlug}".`);
      result = await this.#discovery.requeueListings({ locationId: location.id });
    }
    this.#logger.debug({ target, requeued: result.requeued }, "Listings sent back to be processed again");
    return result;
  }

  async #process(raw: ClaimedRawListing): Promise<ProcessingOutcome> {
    const started = performance.now();
    const context = { rawListingId: raw.id, listingId: raw.listingId, source: raw.source.name };

    if (raw.kind === "removed") {
      const unlinked = await this.#catalogue.removeSourceLink({ listingId: raw.listingId, rawListingId: raw.id });
      await this.#discovery.markRawListingProcessed(raw.id);
      this.#logger.info({ ...context, unlinked: unlinked.length }, "Removed listing processed");
      return outcomeOf(raw, { experiences: 0, created: 0, changed: 0, unlinked: unlinked.length });
    }

    const extractor = this.#extractors.get(raw.source.kind);
    if (extractor === undefined) {
      throw new UnreadableListing(`No extractor reads the source kind "${raw.source.kind}" yet.`);
    }
    if (raw.content === null) throw new UnreadableListing("The raw listing has no content.");
    const location = await this.#catalogue.getLocation({ id: raw.source.locationId });
    if (location === null) throw new Error(`The source's location ${raw.source.locationId} does not exist.`);

    const now = this.#clock();
    const fetchedAt = new Date(raw.fetchedAt);
    const answered = await extractor.extract({
      content: raw.content,
      contentType: raw.contentType ?? "",
      ...(raw.url === null ? {} : { url: raw.url }),
      fetchedAt,
      now,
      location,
    });
    const { horizonEnd } = sourcingWindow({
      fetchedAt,
      now,
      timezone: location.timezone,
      horizonMonths: this.#settings.horizonMonths,
    });

    // The definitions are read once per raw listing, so a changed definition applies from the next one on.
    const [definitions, seasons, linked] = await Promise.all([
      this.#repository.listDefinitions(),
      this.#repository.listSeasons(location.id),
      this.#catalogue.findExperiencesByListing(raw.listingId),
    ]);
    const instructions = classificationInstructions(definitions);

    // The experiences this version matched. Two extracted experiences never match the same stored one.
    const taken = new Set<string>();
    const saved: SaveExperienceResult[] = [];
    const undefinedValues: UndefinedValueRow[] = [];

    // A season the extractor took for an experience is left out: seasons are tags, never experiences.
    const extracted = answered.filter((experience) => {
      const season = seasonItIs(experience, seasons);
      if (season === undefined) return true;
      this.#logger.warn({ ...context, title: experience.title, season: season.slug }, "Season left out, not an experience");
      return false;
    });

    for (const experience of extracted) {
      const { classification, answer } = await this.#classify(experience, definitions, instructions);
      for (const found of classification.undefinedValues) {
        this.#logger.warn({ ...context, title: experience.title, ...found }, "Undefined value saved for review");
        undefinedValues.push({
          rawListingId: raw.id,
          kind: found.kind,
          value: found.value,
          extractedExperience: experience,
          modelAnswer: answer,
        });
      }
      if (classification.misfits.length > 0) {
        this.#logger.warn({ ...context, title: experience.title, values: classification.misfits }, "Values left off");
      }

      const span = spanOf(experience, horizonEnd);
      const match = await this.#match({ experience, span, extracted, linked, taken, location });
      if (match) taken.add(match.id);
      const precedence = match
        ? precedenceOf(raw.source.priority, raw.listingId, await this.#discovery.getListingPriorities(match.listingIds))
        : "lead";

      const tags = [...classification.tags];
      for (const slug of seasonsOf(experience, seasons, horizonEnd)) if (!tags.includes(slug)) tags.push(slug);

      const result = await this.#catalogue.saveExperience(
        saveInput({
          experience,
          location,
          raw,
          match,
          precedence,
          attributes: classification.attributes,
          tags,
          profile: classification.profile,
        }),
      );
      taken.add(result.experience.id);
      saved.push(result);
      if (result.created || result.changed) {
        this.#logger.info(
          {
            ...context,
            experienceId: result.experience.id,
            version: result.experience.version,
            change: result.change,
            precedence,
          },
          result.created ? "Experience published" : "Experience changed",
        );
      }
    }

    // Links that fall away: what this listing linked to before and no longer describes.
    let unlinked = 0;
    for (const previous of linked) {
      if (taken.has(previous.id)) continue;
      const removed = await this.#catalogue.removeSourceLink({
        listingId: raw.listingId,
        experienceId: previous.id,
        rawListingId: raw.id,
      });
      unlinked += removed.length;
    }

    const rows: WarehouseRow[] = saved.map((result) => ({
      experienceId: result.experience.id,
      rawListingId: raw.id,
      version: result.experience.version,
      experience: { ...result.experience },
    }));
    await this.#repository.appendWarehouseRows(rows);
    await this.#repository.saveUndefinedValues(undefinedValues);
    await this.#discovery.markRawListingProcessed(raw.id);

    const counts = {
      experiences: saved.length,
      created: saved.filter((result) => result.created).length,
      changed: saved.filter((result) => result.changed && !result.created).length,
      unlinked,
    };
    this.#logger.info(
      { ...context, ...counts, milliseconds: Math.round(performance.now() - started) },
      "Raw listing processed",
    );
    return outcomeOf(raw, counts);
  }

  async #classify(experience: ExtractedExperience, definitions: Definitions, instructions: string) {
    const answer = await this.#languageModel.ask({
      instructions,
      text: classificationText(experience),
      schema: classificationAnswerSchema,
    });
    return { answer, classification: checkClassification(answer, definitions) };
  }

  // The stored experience this extracted one is, or undefined for a new one.
  async #match(input: {
    experience: ExtractedExperience;
    span: Span;
    extracted: ExtractedExperience[];
    linked: ExperienceMatch[];
    taken: Set<string>;
    location: Location;
  }): Promise<ExperienceMatch | undefined> {
    const { experience, span, linked, taken } = input;

    // The listing's own links first. A listing of one experience that links to one still open updates it.
    const open = linked.filter((match) => !isFinal(match));
    const only = open[0];
    if (input.extracted.length === 1 && open.length === 1 && only !== undefined) return only;
    // A cancelled experience is final, but the listing that still says so matches it rather than making a copy.
    const comparable = linked.filter(
      (match) =>
        !taken.has(match.id) &&
        (!isFinal(match) || (match.status === "cancelled" && experience.status === "cancelled")),
    );
    const byLink = matchLinked(experience, comparable);
    if (byLink) return byLink;

    // Dates known only to the month or year need only be near, on whichever side they are (see datesFit).
    const near = nearDates(span);
    const dates = onlyMonthOrYear(experience) ? { from: near.start, to: near.end } : { from: span.start, to: span.end };
    const candidates = (
      await this.#catalogue.findMatchCandidates({
        locationId: input.location.id,
        title: experience.title,
        ...dates,
        monthOrYear: { from: near.start, to: near.end },
      })
    ).filter((candidate) => !taken.has(candidate.id) && !isFinal(candidate));
    if (candidates.length === 0) return undefined;
    const inCode = matchInCode(experience, span, candidates);
    if (inCode) return inCode;

    const answer = await this.#languageModel.ask({
      instructions: MATCH_INSTRUCTIONS,
      text: matchText(experience, span, candidates),
      schema: matchAnswerSchema,
    });
    return pickedCandidate(answer, candidates);
  }

  // In the claim's transaction, after the work has rolled back: nothing from the raw listing is saved.
  async #fail(raw: ClaimedRawListing, error: unknown): Promise<ProcessingOutcome> {
    const text = errorText(error);
    const marked = await this.#discovery.markRawListingFailed(raw.id, text);
    const context = {
      rawListingId: raw.id,
      listingId: raw.listingId,
      source: raw.source.name,
      kind: raw.source.kind,
      attempts: marked.attempts,
      willRetry: marked.willRetry,
      error: text,
    };
    if (isInputFailure(error)) this.#logger.warn(context, "Raw listing failed");
    else this.#logger.error({ ...context, err: error }, "Raw listing failed");
    return {
      rawListingId: raw.id,
      listingId: raw.listingId,
      sourceName: raw.source.name,
      outcome: "failed",
      experiences: 0,
      created: 0,
      changed: 0,
      unlinked: 0,
      error: text,
    };
  }

  async listAttributes(): Promise<AttributeDefinition[]> {
    return (await this.#repository.listDefinitions()).attributes;
  }

  async saveAttribute(input: AttributeDefinition): Promise<AttributeDefinition> {
    const details: ErrorDetail[] = [];
    if (input.type !== "option" && input.options.length > 0) {
      details.push({ path: "options", message: "Only an option attribute has options." });
    }
    const seen = new Set<string>();
    input.options.forEach((option, index) => {
      if (seen.has(option.key)) {
        details.push({ path: `options.${index}.key`, message: `"${option.key}" appears twice.` });
      }
      seen.add(option.key);
    });
    const problem = defaultValueProblem(input);
    if (problem) details.push({ path: "defaultValue", message: problem });
    if (details.length > 0) {
      throw new AppError("invalid_input", `The attribute "${input.key}" is not valid.`, details);
    }

    const saved = await this.#repository.upsertAttribute(input);
    this.#logger.info({ key: saved.key, type: saved.type, options: saved.options.length }, "Attribute saved");
    return saved;
  }

  async saveTag(input: TagDefinition): Promise<TagDefinition> {
    const saved = await this.#repository.upsertTag(input);
    this.#logger.info({ slug: saved.slug }, "Tag saved");
    return saved;
  }

  async saveSeason(input: SaveSeasonInput): Promise<Season> {
    const details: ErrorDetail[] = [];
    input.periods.forEach((period, index) => {
      if (!isIsoDate(period.startDate)) {
        details.push({ path: `periods.${index}.startDate`, message: "Must be a date as YYYY-MM-DD." });
      }
      if (!isIsoDate(period.endDate)) {
        details.push({ path: `periods.${index}.endDate`, message: "Must be a date as YYYY-MM-DD." });
      } else if (isIsoDate(period.startDate) && period.endDate < period.startDate) {
        details.push({ path: `periods.${index}.endDate`, message: "Must not be before the start date." });
      }
    });
    if (details.length > 0) {
      throw new AppError("invalid_input", `The season "${input.slug}" is not valid.`, details);
    }

    // Locations are Catalogue's, so the season's location is found through the Catalogue service.
    const location = await this.#catalogue.getLocation({ slug: input.locationSlug });
    if (!location) {
      throw new AppError("not_found", `No location with the slug "${input.locationSlug}".`, [
        { path: "locationSlug", message: "No such location." },
      ]);
    }

    const saved = await this.#repository.upsertSeason({
      locationId: location.id,
      slug: input.slug,
      name: input.name,
      description: input.description,
      periods: input.periods,
    });
    this.#logger.info(
      { seasonId: saved.id, slug: saved.slug, location: location.slug, periods: saved.periods.length },
      "Season saved",
    );
    return saved;
  }
}
