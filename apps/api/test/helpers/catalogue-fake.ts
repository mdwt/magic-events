import type {
  CatalogueRepository,
  ChangedExperienceRecord,
  ExperienceChangesQuery,
  ExperienceWrite,
  Location,
  SaveExperienceInput,
  StoredExperience,
} from "../../src/core/catalogue/ports.ts";
import { CatalogueService } from "../../src/core/catalogue/service.ts";
import type { DomainEvent, DomainEventPublisher } from "../../src/core/shared/domain-events.ts";
import type { Logger } from "../../src/core/shared/logger.ts";
import { EMBEDDING_SETTINGS, FakeEmbeddingModel } from "./fake-embedding-model.ts";

// Catalogue's save side with no database: a repository that keeps what it is handed in memory, a clock that a
// test sets, and a logger that keeps its warnings.

export const HERMANUS: Location = {
  id: "00000000-0000-4000-8000-0000000000aa",
  name: "Hermanus",
  slug: "hermanus",
  country: "ZA",
  region: "Western Cape",
  timezone: "Africa/Johannesburg",
  latitude: -34.4187,
  longitude: 19.2345,
};

export const LISTING_A = "00000000-0000-4000-8000-00000000000a";
export const LISTING_B = "00000000-0000-4000-8000-00000000000b";
export const RAW_A = "00000000-0000-4000-8000-0000000000a1";
export const RAW_B = "00000000-0000-4000-8000-0000000000b1";

export function fakeCatalogue(options: { now?: string; locations?: Location[] } = {}) {
  const experiences = new Map<string, StoredExperience>();
  const locations = new Map((options.locations ?? [HERMANUS]).map((one) => [one.id, one]));
  const writes: ExperienceWrite[] = [];
  const warnings: { context: object; message: string }[] = [];
  const errors: { context: object; message: string }[] = [];
  // What changed-since is answered with, and the queries it was handed.
  const changes = { answer: { items: [] as ChangedExperienceRecord[], total: 0 }, queries: [] as ExperienceChangesQuery[] };
  // Experiences whose save fails, and the batch sizes the upkeep asked for.
  const failing = new Set<string>();
  const upkeepLimits: number[] = [];
  const clock = { now: new Date(options.now ?? "2026-11-23T10:00:00.000Z") };

  const repository: CatalogueRepository = {
    searchExperiences: () => Promise.resolve({ items: [], total: 0 }),
    upsertLocation: (input) => {
      const saved = { id: crypto.randomUUID(), ...input };
      locations.set(saved.id, saved);
      return Promise.resolve(saved);
    },
    findLocation: (by) =>
      Promise.resolve([...locations.values()].find((one) => ("id" in by ? one.id === by.id : one.slug === by.slug)) ?? null),
    loadExperiences: (by) => {
      const found =
        "ids" in by
          ? by.ids.map((id) => experiences.get(id)).filter((one) => one !== undefined)
          : [...experiences.values()].filter((one) => one.listingIds.includes(by.listingId));
      return Promise.resolve(structuredClone(found));
    },
    findExperienceId: (by) => {
      const found = [...experiences.values()].find((one) => ("id" in by ? one.id === by.id : one.slug === by.slug));
      return Promise.resolve(found?.id ?? null);
    },
    findMatchCandidateIds: () => Promise.resolve([]),
    findTakenSlugs: (base) =>
      Promise.resolve(
        [...experiences.values()].map((one) => one.slug).filter((slug) => slug === base || slug.startsWith(`${base}-`)),
      ),
    // Embedding has its own tests.
    findExperiencesToEmbed: () => Promise.resolve({ items: [], total: 0 }),
    storeEmbeddings: () => Promise.resolve(0),
    saveExperiences: (batch) => {
      const appended: DomainEvent[] = [];
      if (batch.some((write) => failing.has(write.experience.id))) return Promise.reject(new Error("the save failed"));
      for (const write of batch) {
        const stored = experiences.get(write.experience.id);
        if ((stored?.version ?? null) !== write.previousVersion) throw new Error("version mismatch");
        experiences.set(write.experience.id, structuredClone(write.experience));
        writes.push(structuredClone(write));
        if (write.event !== null) {
          const row = { id: crypto.randomUUID(), resourceId: write.experience.id, recordedAt: write.at.toISOString() };
          appended.push(
            write.event.type === "experience.published"
              ? { ...row, type: write.event.type, data: write.event.data }
              : { ...row, type: write.event.type, data: write.event.data },
          );
        }
      }
      return Promise.resolve(appended);
    },
    findChangesSince: (query) => {
      changes.queries.push(query);
      return Promise.resolve(structuredClone(changes.answer));
    },
    // Every experience, in ID order: the service, not the query, decides what is due.
    findUpkeepCandidates: (query) => {
      upkeepLimits.push(query.limit);
      const ids = [...experiences.keys()].sort().filter((id) => query.after === null || id > query.after);
      return Promise.resolve(ids.slice(0, query.limit));
    },
  };

  // Records what the service publishes.
  const published: DomainEvent[] = [];
  const events: DomainEventPublisher = {
    publish: (event) => {
      published.push(event);
    },
  };

  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (context, message) => warnings.push({ context, message }),
    error: (context, message) => errors.push({ context, message }),
    child: () => logger,
  };

  const service = new CatalogueService({
    repository,
    events,
    settings: { searchDefaultRadiusKm: 25, searchMaxRadiusKm: 200, sessionHorizonMonths: 24, upkeepCron: "0 * * * *" },
    embeddings: new FakeEmbeddingModel(),
    embeddingSettings: EMBEDDING_SETTINGS,
    logger,
    clock: () => clock.now,
  });

  return {
    service,
    experiences,
    writes,
    published,
    warnings,
    errors,
    changes,
    failing,
    upkeepLimits,
    // The published domain events, as type, resource and data.
    publishedEvents() {
      return published.map(({ type, resourceId, data }) => ({ type, resourceId, data }));
    },
    // Sets the time now.
    at(iso: string) {
      clock.now = new Date(iso);
    },
    // Puts a stored experience in a given state, as if earlier saves or Catalogue's schedule had left it so.
    set(id: string, change: Partial<StoredExperience>) {
      const stored = experiences.get(id);
      if (stored === undefined) throw new Error(`no experience ${id}`);
      experiences.set(id, { ...stored, ...change });
    },
  };
}

// A whole listing as Data processing would save it: a confirmed single on one evening.
export function input(overrides: Partial<SaveExperienceInput> = {}): SaveExperienceInput {
  return {
    locationId: HERMANUS.id,
    title: "Jazz on the Cliffs",
    summary: "An evening of jazz.",
    description: "Local and visiting players on the cliff path.",
    profile: "A relaxed jazz evening outdoors by the sea.",
    type: "single",
    status: "confirmed",
    booking: "open",
    openingHours: "From 18:00",
    venue: { name: "Gearing's Point", address: "Marine Drive", city: "Hermanus", position: { lat: -34.42, lng: 19.24 } },
    price: { min: 150, max: 300, currency: "ZAR" },
    onSaleAt: "2027-01-10T09:00:00.000Z",
    bookingClosesAt: "2027-03-12T16:00:00.000Z",
    bookingUrl: "https://tickets.example.com/jazz",
    imageUrl: "https://tickets.example.com/jazz.jpg",
    sessions: [{ startDate: "2027-03-13", precision: "day", startTime: "18:00", endTime: "22:00" }],
    attributes: { category: ["music"], audience: ["adults"] },
    tags: ["jazz"],
    source: { listingId: LISTING_A, rawListingId: RAW_A },
    precedence: "lead",
    ...overrides,
  };
}
