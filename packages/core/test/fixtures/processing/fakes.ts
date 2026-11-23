import type {
  Catalogue,
  ExperienceMatch,
  Location,
  MatchCandidatesInput,
  SaveExperienceInput,
  StoredExperience,
} from "../../../src/catalogue/ports.ts";
import type {
  AttributeDefinition,
  DataProcessingRepository,
  Season,
  TagDefinition,
  UndefinedValueRow,
  WarehouseRow,
} from "../../../src/data-processing/ports.ts";
import { DataProcessingService } from "../../../src/data-processing/service.ts";
import type { ClaimedRawListing, Discovery } from "../../../src/discovery/ports.ts";
import type { Logger } from "../../../src/shared/logger.ts";
import type { Transactions } from "../../../src/shared/transactions.ts";
import { fakeLanguageModel, type FakeLanguageModel } from "../../../src/testing/fake-language-model.ts";

// Data processing with no database: in-memory fakes of Discovery, Catalogue and the repository, and transactions
// that put every fake back as it was when the work throws, as a database transaction would.

export const HERMANUS: Location = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Hermanus",
  slug: "hermanus",
  country: "South Africa",
  region: "Western Cape",
  timezone: "Africa/Johannesburg",
  latitude: -34.4187,
  longitude: 19.2345,
};

export const LISTING = "00000000-0000-4000-8000-00000000000a";
export const OTHER_LISTING = "00000000-0000-4000-8000-00000000000b";
export const RAW = "00000000-0000-4000-8000-0000000000a1";
export const NOW = "2026-11-23T08:00:00.000Z";

export function rawListing(overrides: Partial<ClaimedRawListing> = {}): ClaimedRawListing {
  return {
    id: RAW,
    listingId: LISTING,
    kind: "listing",
    source: {
      id: "source-1",
      name: "FynArts site",
      kind: "web_page",
      priority: 10,
      locationId: HERMANUS.id,
      ownPages: false,
      missedRunsBeforeRemoval: 3,
    },
    url: "https://fynarts.example.com/",
    contentType: "text/html",
    content: "<html><body><h1>Hermanus FynArts</h1><p>12 to 21 June 2027</p></body></html>",
    fetchedAt: NOW,
    attempts: 0,
    ...overrides,
  };
}

export const ATTRIBUTES: AttributeDefinition[] = [
  {
    key: "category",
    name: "Category",
    description: "What it is about",
    type: "option",
    defaultValue: null,
    multiple: true,
    filterable: true,
    options: [
      { key: "music", name: "Music", description: "Concerts and gigs" },
      { key: "visual_arts", name: "Visual arts", description: "Exhibitions" },
      { key: "food_and_drink", name: "Food and drink", description: "Tastings" },
    ],
  },
  {
    key: "audience",
    name: "Audience",
    description: "Who it is for",
    type: "option",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [
      { key: "family", name: "Family", description: "For families" },
      { key: "adults", name: "Adults", description: "For adults" },
    ],
  },
  {
    key: "scale",
    name: "Scale",
    description: "How far people travel",
    type: "option",
    defaultValue: "local",
    multiple: false,
    filterable: true,
    options: [
      { key: "local", name: "Local", description: "The town" },
      { key: "major", name: "Major", description: "The country" },
    ],
  },
  {
    key: "minimum_age",
    name: "Minimum age",
    description: "The age limit a source states",
    type: "number",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [],
  },
  {
    key: "wheelchair_accessible",
    name: "Wheelchair accessible",
    description: "Only when a source says so",
    type: "boolean",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [],
  },
];

export const TAGS: TagDefinition[] = [
  { slug: "jazz", name: "Jazz", description: "Jazz music" },
  { slug: "wine", name: "Wine", description: "Wine tastings" },
];

export const SEASONS: Season[] = [
  {
    id: "season-1",
    locationId: HERMANUS.id,
    slug: "whale-season",
    name: "Whale season",
    description: "Whales in the bay",
    periods: [
      { startDate: "2026-06-01", endDate: "2026-11-30" },
      { startDate: "2027-06-01", endDate: "2027-11-30" },
    ],
  },
  {
    id: "season-2",
    locationId: HERMANUS.id,
    slug: "summer",
    name: "Summer",
    description: "December to February",
    periods: [{ startDate: "2026-12-01", endDate: "2027-02-28" }],
  },
];

// One stored experience as matching sees it.
export function stored(overrides: Partial<ExperienceMatch> = {}): ExperienceMatch {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    title: "Hermanus FynArts",
    type: "single",
    status: "announced",
    venueName: null,
    city: "Hermanus",
    firstDate: "2027-06-12",
    lastDate: "2027-06-21",
    sessions: [{ startDate: "2027-06-12", endDate: "2027-06-21", startTime: null }],
    onlyMonthOrYear: false,
    recurrenceRule: null,
    listingIds: [LISTING],
    ...overrides,
  };
}

function storedExperience(id: string, version: number, input: SaveExperienceInput, listingIds: string[]): StoredExperience {
  return {
    id,
    version,
    locationId: input.locationId,
    title: input.title,
    slug: input.title.toLowerCase().replace(/\W+/g, "-"),
    summary: input.summary ?? null,
    description: input.description ?? null,
    profile: input.profile ?? null,
    type: input.type,
    status: input.status,
    booking: input.booking,
    timezone: HERMANUS.timezone,
    openingHours: input.openingHours ?? null,
    venue: { name: input.venue?.name ?? null, address: null, city: input.venue?.city ?? null, position: null },
    price: { min: input.price?.min ?? null, max: input.price?.max ?? null, currency: input.price?.currency ?? null },
    onSaleAt: null,
    bookingClosesAt: null,
    bookingUrl: input.bookingUrl ?? null,
    imageUrl: null,
    pageUrl: null,
    recurrence: null,
    sessions: input.sessions.map((session) => ({
      startDate: session.startDate,
      endDate: session.endDate ?? session.startDate,
      precision: session.precision,
      startTime: session.startTime ?? null,
      endTime: session.endTime ?? null,
      label: session.label ?? null,
      soldOut: session.soldOut ?? false,
      status: session.cancelled ? "cancelled" : "scheduled",
      origin: "listed",
    })),
    attributes: input.attributes,
    tags: input.tags,
    listingIds,
  };
}

interface State {
  experiences: Map<string, ExperienceMatch>;
  saves: SaveExperienceInput[];
  removals: { listingId: string; experienceId?: string; rawListingId: string }[];
  warehouse: WarehouseRow[];
  undefinedValues: UndefinedValueRow[];
  processed: string[];
  pending: ClaimedRawListing[];
}

export function setup(
  options: {
    pending?: ClaimedRawListing[];
    experiences?: ExperienceMatch[];
    // What findMatchCandidates returns. Left out, it returns every stored experience not in a final status.
    candidates?: ExperienceMatch[];
    priorities?: Record<string, number>;
    model?: FakeLanguageModel;
    // Makes saveExperience throw, as Catalogue would for input it refuses.
    saveFails?: Error;
    maxAttempts?: number;
  } = {},
) {
  const state: State = {
    experiences: new Map((options.experiences ?? []).map((one) => [one.id, one])),
    saves: [],
    removals: [],
    warehouse: [],
    undefinedValues: [],
    processed: [],
    pending: [...(options.pending ?? [rawListing()])],
  };
  const failures: { id: string; error: string; attempts: number; willRetry: boolean }[] = [];
  const attempts = new Map<string, number>();
  // What each claim returned, so a failed one can go back to pending.
  const claimed = new Map<string, ClaimedRawListing>();
  const logs: { level: string; context: Record<string, unknown>; message: string }[] = [];
  // What each search for match candidates was given.
  const candidateQueries: MatchCandidatesInput[] = [];
  let created = 0;

  const transactions: Transactions = {
    async run(work) {
      const before = structuredClone(state);
      try {
        return await work();
      } catch (error) {
        // Put back in place, so a test that holds the state sees the rollback.
        Object.assign(state, before);
        throw error;
      }
    },
  };

  const discovery: Discovery = {
    saveSource: () => Promise.reject(new Error("not used")),
    listSources: () => Promise.reject(new Error("not used")),
    findDueSources: () => Promise.reject(new Error("not used")),
    runSource: () => Promise.reject(new Error("not used")),
    runLocation: () => Promise.reject(new Error("not used")),
    getListing: () => Promise.reject(new Error("not used")),
    requeueListings: () => Promise.reject(new Error("not used")),
    claimPendingRawListing() {
      const raw = state.pending.shift() ?? null;
      if (raw) claimed.set(raw.id, raw);
      return Promise.resolve(raw);
    },
    markRawListingProcessed(id) {
      state.processed.push(id);
      return Promise.resolve();
    },
    markRawListingFailed(id, error) {
      const count = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, count);
      const willRetry = count < (options.maxAttempts ?? 3);
      // Back to pending until it reaches its limit, as Discovery does.
      const raw = claimed.get(id);
      if (willRetry && raw) state.pending.unshift(raw);
      failures.push({ id, error, attempts: count, willRetry });
      return Promise.resolve({ attempts: count, willRetry });
    },
    getListingPriorities: (ids) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, options.priorities?.[id] ?? 10]))),
  };

  const catalogue: Catalogue = {
    searchExperiences: () => Promise.reject(new Error("not used")),
    saveLocation: () => Promise.reject(new Error("not used")),
    getLocation: (by) => Promise.resolve(("id" in by ? by.id === HERMANUS.id : by.slug === HERMANUS.slug) ? HERMANUS : null),
    getExperience: () => Promise.reject(new Error("not used")),
    findExperiencesByListing: (listingId) =>
      Promise.resolve([...state.experiences.values()].filter((one) => one.listingIds.includes(listingId))),
    findMatchCandidates: (input) => {
      candidateQueries.push(input);
      return Promise.resolve(
        options.candidates ??
          [...state.experiences.values()].filter((one) => !["cancelled", "removed", "past"].includes(one.status)),
      );
    },
    saveExperience(input) {
      if (options.saveFails) return Promise.reject(options.saveFails);
      state.saves.push(input);
      const existing = input.experienceId === undefined ? undefined : state.experiences.get(input.experienceId);
      created += existing ? 0 : 1;
      const id = existing?.id ?? `00000000-0000-4000-8000-${String(created).padStart(12, "0")}`;
      const listingIds = [...new Set([...(existing?.listingIds ?? []), input.source.listingId])];
      const version = existing ? 2 : 1;
      state.experiences.set(id, {
        ...stored({ id, title: input.title, status: input.status, listingIds }),
      });
      return Promise.resolve({
        experience: storedExperience(id, version, input, listingIds),
        created: !existing,
        changed: true,
        change: existing ? "changed" : "new",
      });
    },
    removeSourceLink(input) {
      state.removals.push(input);
      const ids: string[] = [];
      for (const one of state.experiences.values()) {
        if (input.experienceId !== undefined && one.id !== input.experienceId) continue;
        if (!one.listingIds.includes(input.listingId)) continue;
        one.listingIds = one.listingIds.filter((id) => id !== input.listingId);
        ids.push(one.id);
      }
      return Promise.resolve(ids);
    },
    getChangesSince: () => Promise.reject(new Error("not used")),
    keepUp: () => Promise.reject(new Error("not used")),
    embedExperiences: () => Promise.reject(new Error("not used")),
  };

  const repository: DataProcessingRepository = {
    upsertAttribute: (input) => Promise.resolve(input),
    upsertTag: (input) => Promise.resolve(input),
    upsertSeason: (input) => Promise.resolve({ id: "season", ...input }),
    listDefinitions: () => Promise.resolve({ attributes: ATTRIBUTES, tags: TAGS }),
    listTagSlugs: () => Promise.resolve(TAGS.map((one) => one.slug)),
    listSeasons: (locationId) => Promise.resolve(SEASONS.filter((one) => one.locationId === locationId)),
    appendWarehouseRows(rows) {
      state.warehouse.push(...rows);
      return Promise.resolve();
    },
    saveUndefinedValues(rows) {
      state.undefinedValues.push(...rows);
      return Promise.resolve();
    },
  };

  const record =
    (level: string) =>
    (context: object, message: string): void => {
      logs.push({ level, context: context as Record<string, unknown>, message });
    };
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
  };

  const model = options.model ?? fakeLanguageModel();
  const service = new DataProcessingService({
    repository,
    catalogue,
    discovery,
    languageModel: model,
    transactions,
    settings: { horizonMonths: 24, workers: 1 },
    logger,
    clock: () => new Date(NOW),
  });

  return {
    service,
    model,
    failures,
    logs,
    state,
    candidateQueries,
  };
}
