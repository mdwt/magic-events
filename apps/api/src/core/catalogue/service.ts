import { randomUUID } from "node:crypto";
import type { Clock } from "../shared/clock.ts";
import type { DomainEventPublisher } from "../shared/domain-events.ts";
import { AppError, type ErrorDetail } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { CatalogueSettings, EmbeddingSettings } from "../shared/settings.ts";
import {
  SEARCHABLE_STATUSES,
  type Catalogue,
  type CatalogueRepository,
  type EmbedExperiencesResult,
  type EmbeddingModel,
  type ExperienceMatch,
  type ExperienceSearchQuery,
  type ExperienceStatus,
  type ExperienceToEmbed,
  type ExperienceWrite,
  type Location,
  type SaveExperienceInput,
  type SaveExperienceResult,
  type SaveLocationInput,
  type SearchExperiencesInput,
  type SearchExperiencesResult,
  type StoredExperience,
} from "./ports.ts";
import { addMonths, dayIn } from "./recurrence.ts";
import {
  FINAL_STATUSES,
  allowedBooking,
  canMove,
  changeKind,
  changedFields,
  generateSessions,
  meet,
  previousValues,
  readInput,
  sameSessions,
  slugify,
  sortSessions,
  uniqueSlug,
  type Draft,
} from "./save.ts";
import { reportedChange } from "./changes.ts";
import type {
  ExperienceChange,
  ExperienceChangesInput,
  ExperienceChangesQuery,
  ExperienceChangesResult,
  UpkeepResult,
} from "./ports.ts";
import { LATEST_TIMEZONE, upkeepOf } from "./upkeep.ts";

// The most match candidates Data processing is shown.
const MAX_CANDIDATES = 10;
// The most sessions a match carries.
const MATCH_SESSIONS = 50;
// How many experiences the upkeep loads at a time.
const UPKEEP_BATCH = 200;

export class CatalogueService implements Catalogue {
  readonly #repository: CatalogueRepository;
  readonly #settings: CatalogueSettings;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #events: DomainEventPublisher;
  readonly #embeddings: EmbeddingModel;
  readonly #embeddingSettings: EmbeddingSettings;

  constructor(deps: {
    repository: CatalogueRepository;
    events: DomainEventPublisher;
    settings: CatalogueSettings;
    embeddings: EmbeddingModel;
    embeddingSettings: EmbeddingSettings;
    logger: Logger;
    clock?: Clock;
  }) {
    this.#repository = deps.repository;
    this.#events = deps.events;
    this.#settings = deps.settings;
    this.#embeddings = deps.embeddings;
    this.#embeddingSettings = deps.embeddingSettings;
    this.#logger = deps.logger;
    this.#clock = deps.clock ?? (() => new Date());
  }

  async searchExperiences(input: SearchExperiencesInput): Promise<SearchExperiencesResult> {
    const resolved = this.#resolve(input);
    this.#logger.debug({ query: resolved }, "Searching experiences");

    const started = performance.now();
    // A query text is embedded to order by meaning. Without its embedding the order is by keyword alone.
    const queryEmbedding = resolved.query === undefined ? null : await this.#queryEmbedding(resolved.query);
    const query = queryEmbedding === null ? resolved : { ...resolved, queryEmbedding };
    const { items, total } = await this.#repository.searchExperiences(query);
    this.#logger.debug(
      {
        count: items.length,
        total,
        byMeaning: queryEmbedding !== null,
        durationMs: Math.round(performance.now() - started),
      },
      "Searched experiences",
    );

    return {
      items: items.map((item) => ({ ...item, bookable: item.status === "confirmed" && item.booking === "open" })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  saveLocation(input: SaveLocationInput): Promise<Location> {
    return this.#repository.upsertLocation(input);
  }

  getLocation(by: { id: string } | { slug: string }): Promise<Location | null> {
    return this.#repository.findLocation(by);
  }

  async getExperience(by: { id: string } | { slug: string }): Promise<StoredExperience | null> {
    const id = await this.#repository.findExperienceId(by);
    if (id === null) return null;
    const [found] = await this.#repository.loadExperiences({ ids: [id] });
    return found ?? null;
  }

  async findExperiencesByListing(listingId: string): Promise<ExperienceMatch[]> {
    const experiences = await this.#repository.loadExperiences({ listingId });
    return experiences.map(toMatch);
  }

  async findMatchCandidates(input: {
    locationId: string;
    title: string;
    from: string;
    to: string;
  }): Promise<ExperienceMatch[]> {
    const ids = await this.#repository.findMatchCandidateIds({ ...input, limit: MAX_CANDIDATES });
    if (ids.length === 0) return [];
    const byId = new Map((await this.#repository.loadExperiences({ ids })).map((one) => [one.id, one]));
    const candidates = ids.map((id) => byId.get(id)).filter((one) => one !== undefined);
    this.#logger.debug({ title: input.title, count: candidates.length }, "Found match candidates");
    return candidates.map(toMatch);
  }

  async saveExperience(input: SaveExperienceInput): Promise<SaveExperienceResult> {
    const incoming = readInput(input);
    const at = this.#clock();
    if (input.experienceId === undefined) return this.#create(input, incoming, at);

    const [stored] = await this.#repository.loadExperiences({ ids: [input.experienceId] });
    if (stored === undefined) {
      throw new AppError("not_found", "No experience has this ID.", [
        { path: "experienceId", message: "No such experience." },
      ]);
    }
    const next = this.#nextOf(stored, incoming, input, at);
    const fields = changedFields(stored, next);
    const profileChanged = stored.profile !== next.profile;
    const generatedChanged = !sameSessions(stored.sessions, next.sessions);
    const log = { experienceId: stored.id, listingId: input.source.listingId, rawListingId: input.source.rawListingId };

    if (fields.length === 0 && !profileChanged && !generatedChanged) {
      this.#logger.debug(log, "Saved experience unchanged");
      return { experience: stored, created: false, changed: false, change: null };
    }

    // A change to the profile alone, or sessions generated further ahead, is saved without a new version.
    const kind = fields.length > 0 ? changeKind(stored, next) : null;
    const experience: StoredExperience = { ...next, version: kind === null ? stored.version : stored.version + 1 };
    await this.#save([
      {
        experience,
        previousVersion: stored.version,
        replace: {
          sessions: fields.includes("sessions") || generatedChanged,
          attributes: fields.includes("attributes"),
          tags: fields.includes("tags"),
        },
        links: { add: experience.listingIds.filter((id) => !stored.listingIds.includes(id)), remove: [] },
        clearEmbedding: profileChanged || stored.title !== experience.title,
        change: kind === null ? null : { kind, previous: previousValues(stored, fields) },
        event:
          kind === null
            ? null
            : {
                type: "experience.changed",
                data: { version: experience.version, change: kind, raw_listing_id: input.source.rawListingId },
              },
        at,
      },
    ]);

    if (kind === null) {
      this.#logger.debug({ ...log, profileChanged, generatedChanged }, "Saved experience without a new version");
    } else {
      this.#logger.info({ ...log, version: experience.version, change: kind, fields }, "Experience changed");
    }
    return { experience, created: false, changed: kind !== null, change: kind };
  }

  async removeSourceLink(input: { listingId: string; experienceId?: string; rawListingId: string }): Promise<string[]> {
    const linked = await this.#repository.loadExperiences({ listingId: input.listingId });
    const targets = input.experienceId === undefined ? linked : linked.filter((one) => one.id === input.experienceId);
    if (targets.length === 0) return [];
    const at = this.#clock();

    const writes = targets.map((stored): ExperienceWrite => {
      const listingIds = stored.listingIds.filter((id) => id !== input.listingId);
      const common = {
        previousVersion: stored.version,
        replace: { sessions: false, attributes: false, tags: false },
        links: { add: [], remove: [input.listingId] },
        clearEmbedding: false,
        at,
      };
      // A final experience left with no links keeps its status, and losing the link makes no new version.
      if (listingIds.length === 0 && FINAL_STATUSES.includes(stored.status)) {
        return { ...common, experience: { ...stored, listingIds }, change: null, event: null };
      }
      const next: StoredExperience = { ...stored, listingIds, version: stored.version + 1 };
      if (listingIds.length === 0) {
        next.status = "removed";
        next.booking = allowedBooking("removed", stored.booking);
      }
      const kind = changeKind(stored, next);
      return {
        ...common,
        experience: next,
        change: { kind, previous: previousValues(stored, changedFields(stored, next)) },
        event: {
          type: "experience.changed",
          data: { version: next.version, change: kind, raw_listing_id: input.rawListingId },
        },
      };
    });
    await this.#save(writes);

    for (const write of writes) {
      this.#logger.info(
        {
          experienceId: write.experience.id,
          listingId: input.listingId,
          version: write.experience.version,
          change: write.change?.kind ?? null,
        },
        "Source link removed",
      );
    }
    return targets.map((one) => one.id);
  }

  async getChangesSince(input: ExperienceChangesInput): Promise<ExperienceChangesResult> {
    const since = new Date(input.since);
    const details: ErrorDetail[] = [];
    if (Number.isNaN(since.getTime())) {
      details.push({ path: "since", message: "since must be an ISO timestamp." });
    } else if (since > this.#clock()) {
      details.push({ path: "since", message: "since must not be in the future." });
    }
    if (details.length > 0) {
      this.#logger.warn({ details }, "Changes refused");
      throw new AppError("invalid_input", details.map((detail) => detail.message).join(" "), details);
    }

    // The same rules as a search. The input has no query text, so none is resolved.
    const search = this.#resolve(input);
    const query: ExperienceChangesQuery = {
      near: search.near,
      radiusKm: search.radiusKm,
      from: search.from,
      to: search.to,
      statuses: search.statuses,
      ...(search.bookings === undefined ? {} : { bookings: search.bookings }),
      attributes: search.attributes,
      tags: search.tags,
      limit: search.limit,
      offset: search.offset,
      since,
    };
    this.#logger.debug({ query }, "Finding changes");
    const { items, total } = await this.#repository.findChangesSince(query);

    const changed = items.flatMap(({ experience, changes }): ExperienceChange[] => {
      const change = reportedChange(changes);
      if (change === null) return [];
      return [
        {
          experience: { ...experience, bookable: experience.status === "confirmed" && experience.booking === "open" },
          change,
          changes,
        },
      ];
    });
    this.#logger.debug({ count: changed.length, total }, "Found changes");
    return { items: changed, total, limit: query.limit, offset: query.offset };
  }

  async keepUp(): Promise<UpkeepResult> {
    const at = this.#clock();
    const result: UpkeepResult = { past: 0, bookingsClosed: 0, sessionsGenerated: 0 };
    let after: string | null = null;
    // In batches by ID, so a large catalogue is never loaded at once. Each experience is saved on its own, so one
    // that fails does not stop the others.
    for (;;) {
      const ids = await this.#repository.findUpkeepCandidates({
        lastDateBefore: dayIn(LATEST_TIMEZONE, at),
        bookingClosedBy: at,
        after,
        limit: UPKEEP_BATCH,
      });
      if (ids.length === 0) break;
      for (const stored of await this.#repository.loadExperiences({ ids })) {
        try {
          const upkeep = upkeepOf(stored, at, this.#settings.sessionHorizonMonths);
          if (upkeep === null) continue;
          const { experience, change } = upkeep;
          await this.#save([
            {
              experience,
              previousVersion: stored.version,
              replace: { sessions: upkeep.sessionsChanged, attributes: false, tags: false },
              links: { add: [], remove: [] },
              clearEmbedding: false,
              change:
                change === null
                  ? null
                  : { kind: change, previous: previousValues(stored, changedFields(stored, experience)) },
              event:
                change === null
                  ? null
                  : { type: "experience.changed", data: { version: experience.version, change } },
              at,
            },
          ]);
          if (change === "past") result.past += 1;
          if (change === "changed") result.bookingsClosed += 1;
          result.sessionsGenerated += upkeep.generated;
          const log = { experienceId: stored.id, generated: upkeep.generated };
          if (change === null) {
            this.#logger.debug(log, "Generated sessions further ahead");
          } else {
            this.#logger.info(
              { ...log, version: experience.version, change, status: experience.status, booking: experience.booking },
              change === "past" ? "Experience is over; set to Past" : "Booking closed; its close time has passed",
            );
          }
        } catch (error) {
          this.#logger.error({ experienceId: stored.id, err: error }, "Upkeep of an experience failed");
        }
      }
      after = ids[ids.length - 1] ?? null;
      if (ids.length < UPKEEP_BATCH) break;
    }
    return result;
  }

  async embedExperiences(): Promise<EmbedExperiencesResult> {
    const model = this.#embeddings.model;
    const { items: due, total } = await this.#repository.findExperiencesToEmbed({
      model,
      limit: this.#embeddingSettings.batchSize,
    });
    if (due.length === 0) return { embedded: 0, failed: 0, remaining: 0 };

    const started = performance.now();
    const vectors = await this.#embedDocuments(due);
    const embeddings = due.flatMap((one, index) => {
      const vector = vectors[index];
      return vector === undefined || vector === null ? [] : [{ ...one, vector }];
    });
    // An experience whose title or profile changed while it was embedded is not stored, and stays due.
    const embedded = embeddings.length === 0 ? 0 : await this.#repository.storeEmbeddings({ model, embeddings });
    const failed = due.length - embeddings.length;
    const remaining = total - embedded;
    this.#logger.debug(
      { model, embedded, failed, remaining, durationMs: Math.round(performance.now() - started) },
      "Embedded a round of experiences",
    );
    return { embedded, failed, remaining };
  }

  // The experiences' embeddings as documents. When the round fails as a whole, each text is tried alone, so a text
  // the model fails on is left for the next round and does not hold back the others. Null for a text that failed.
  async #embedDocuments(due: ExperienceToEmbed[]): Promise<(number[] | null)[]> {
    const texts = due.map(embeddingText);
    try {
      return await this.#embeddings.embed(texts, "document");
    } catch (error) {
      if (texts.length === 1) {
        this.#logger.error({ experienceIds: due.map((one) => one.id), err: error }, "The embedding model failed");
        return [null];
      }
      this.#logger.warn({ count: texts.length, err: error }, "The embedding model failed on a round; trying each text");
    }
    const vectors: (number[] | null)[] = [];
    const failedIds: string[] = [];
    let lastError: unknown;
    for (const one of due) {
      try {
        const [vector] = await this.#embeddings.embed([embeddingText(one)], "document");
        vectors.push(vector ?? null);
      } catch (error) {
        vectors.push(null);
        failedIds.push(one.id);
        lastError = error;
      }
    }
    if (failedIds.length > 0) {
      this.#logger.error({ experienceIds: failedIds, err: lastError }, "The embedding model failed");
    }
    return vectors;
  }

  // The query text's embedding, or null when the model fails or does not answer in time. A search never fails
  // because of the embedding model.
  async #queryEmbedding(text: string): Promise<{ vector: number[]; model: string } | null> {
    const timeoutMs = this.#embeddingSettings.queryTimeoutSeconds * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timed out">((resolve) => {
      timer = setTimeout(() => {
        resolve("timed out");
      }, timeoutMs);
    });
    try {
      const answer = await Promise.race([this.#embeddings.embed([text], "query"), timeout]);
      if (answer === "timed out") {
        this.#logger.warn({ timeoutMs }, "The embedding model did not answer in time; ranking by keyword alone");
        return null;
      }
      const [vector] = answer;
      return vector === undefined ? null : { vector, model: this.#embeddings.model };
    } catch (error) {
      this.#logger.error({ err: error }, "The embedding model failed; ranking by keyword alone");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #create(input: SaveExperienceInput, incoming: Draft, at: Date): Promise<SaveExperienceResult> {
    const location = await this.#repository.findLocation({ id: input.locationId });
    if (location === null) {
      throw new AppError("invalid_input", "No location has this ID.", [
        { path: "locationId", message: "No such location." },
      ]);
    }
    const today = dayIn(location.timezone, at);
    const { listed, ...fields } = incoming;
    const sessions = sortSessions([
      ...listed,
      ...generateSessions({ recurrence: fields.recurrence, listed, generated: [], today, horizon: this.#horizon(today) }),
    ]);

    const base = slugify(fields.title);
    const firstDate = sessions[0]?.startDate ?? fields.recurrence?.start ?? null;
    const taken = new Set(await this.#repository.findTakenSlugs(base));
    const experience: StoredExperience = {
      ...fields,
      id: randomUUID(),
      version: 1,
      slug: uniqueSlug(base, firstDate?.slice(0, 4) ?? null, taken),
      timezone: location.timezone,
      booking: this.#booking(fields.status, fields.booking, null),
      sessions,
    };
    await this.#save([
      {
        experience,
        previousVersion: null,
        replace: { sessions: true, attributes: true, tags: true },
        links: { add: experience.listingIds, remove: [] },
        clearEmbedding: false,
        change: { kind: "new", previous: null },
        event: { type: "experience.published", data: { version: 1, raw_listing_id: input.source.rawListingId } },
        at,
      },
    ]);
    this.#logger.info(
      {
        experienceId: experience.id,
        slug: experience.slug,
        listingId: input.source.listingId,
        rawListingId: input.source.rawListingId,
      },
      "Experience published",
    );
    return { experience, created: true, changed: true, change: "new" };
  }

  // The experience as this save leaves it. A final experience changes nothing but its links.
  #nextOf(stored: StoredExperience, incoming: Draft, input: SaveExperienceInput, at: Date): StoredExperience {
    const merged = meet(stored, incoming, input.precedence);
    if (FINAL_STATUSES.includes(stored.status)) return { ...stored, listingIds: merged.listingIds };

    if (input.precedence === "lead") {
      if (canMove(stored.status, input.status)) {
        merged.status = input.status;
      } else {
        this.#logger.warn(
          { experienceId: stored.id, from: stored.status, to: input.status },
          "Status move not allowed; status kept",
        );
      }
      merged.booking = this.#booking(merged.status, input.booking, stored.id);
    }

    const today = dayIn(stored.timezone, at);
    const { listed, ...next } = merged;
    const generated = generateSessions({
      recurrence: next.recurrence,
      listed,
      generated: next.sessions,
      today,
      horizon: this.#horizon(today),
    });
    return { ...next, sessions: sortSessions([...listed, ...generated]) };
  }

  // The booking the status allows. A booking it does not allow is replaced, with a warning.
  #booking(
    status: ExperienceStatus,
    booking: StoredExperience["booking"],
    experienceId: string | null,
  ): StoredExperience["booking"] {
    const allowed = allowedBooking(status, booking);
    if (allowed !== booking) {
      this.#logger.warn({ experienceId, status, booking, saved: allowed }, "Booking not allowed for the status");
    }
    return allowed;
  }

  // Stores the saves, then publishes the domain event each new version appended: one per version, none otherwise.
  async #save(writes: ExperienceWrite[]): Promise<void> {
    const appended = await this.#repository.saveExperiences(writes);
    for (const event of appended) this.#events.publish(event);
  }

  #horizon(today: string): string {
    return addMonths(today, this.#settings.sessionHorizonMonths);
  }

  // Applies the defaults and checks the rules, so the repository runs a query that is already sound.
  #resolve(input: SearchExperiencesInput): ExperienceSearchQuery {
    const details: ErrorDetail[] = [];
    const radiusKm = input.radiusKm ?? this.#settings.searchDefaultRadiusKm;
    if (radiusKm > this.#settings.searchMaxRadiusKm) {
      details.push({ path: "radiusKm", message: `radiusKm must be at most ${this.#settings.searchMaxRadiusKm} km.` });
    }
    if (input.to < input.from) {
      details.push({ path: "to", message: "to must not be before from." });
    }
    const attributes = input.attributes ?? {};
    for (const [key, filter] of Object.entries(attributes)) {
      if (typeof filter !== "object" || Array.isArray(filter)) continue;
      if (filter.min === undefined && filter.max === undefined) {
        details.push({ path: `attributes.${key}`, message: `The range on ${key} needs min or max.` });
      } else if (filter.min !== undefined && filter.max !== undefined && filter.min > filter.max) {
        details.push({ path: `attributes.${key}.min`, message: `The range on ${key} has min above max.` });
      }
    }
    if (details.length > 0) {
      this.#logger.warn({ details }, "Search refused");
      throw new AppError("invalid_input", details.map((detail) => detail.message).join(" "), details);
    }

    // Bookable means Confirmed with booking Open. Status values that leave out Confirmed then match nothing.
    const statuses = input.status ?? [...SEARCHABLE_STATUSES];
    return {
      near: input.near,
      radiusKm,
      from: input.from,
      to: input.to,
      statuses: input.bookable === true ? statuses.filter((status) => status === "confirmed") : statuses,
      ...(input.bookable === true ? { bookings: ["open" as const] } : {}),
      attributes,
      tags: input.tags ?? [],
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit,
      offset: input.offset,
    };
  }
}

// What Data processing is shown to decide whether an extracted experience is this one.
function toMatch(experience: StoredExperience): ExperienceMatch {
  const { sessions } = experience;
  const lastDate = sessions.reduce<string | null>(
    (last, session) => (last === null || session.endDate > last ? session.endDate : last),
    null,
  );
  return {
    id: experience.id,
    title: experience.title,
    type: experience.type,
    status: experience.status,
    venueName: experience.venue.name,
    city: experience.venue.city,
    firstDate: sessions[0]?.startDate ?? null,
    lastDate,
    sessions: sessions.slice(0, MATCH_SESSIONS).map(({ startDate, endDate }) => ({ startDate, endDate })),
    recurrenceRule: experience.recurrence?.rule ?? null,
    listingIds: experience.listingIds,
  };
}

// What an experience is embedded from: its title on the first line, then its profile. Its title alone when it has
// no profile.
function embeddingText(experience: ExperienceToEmbed): string {
  const profile = experience.profile?.trim() ?? "";
  return profile === "" ? experience.title : `${experience.title}\n${profile}`;
}
