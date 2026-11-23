import type { Catalogue, Location } from "../catalogue/ports.ts";
import type { Clock } from "../shared/clock.ts";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { DiscoverySettings } from "../shared/settings.ts";
import { isDue, staleBefore } from "./due.ts";
import { errorMessage, fingerprint, sourcingWindow } from "./fetching.ts";
import type {
  ClaimedRawListing,
  Discovery,
  DiscoveryRepository,
  FetchedListing,
  FetchResult,
  RawListingForMark,
  RunSummary,
  SaveSourceInput,
  Source,
  SourceFetcher,
  SourceForRun,
} from "./ports.ts";

// The five source kinds of version 1. Each has one adapter in Discovery and one extractor in Data processing.
export const SOURCE_KINDS = ["quicket", "ticketmaster", "rss_feed", "pdf_calendar", "web_page"] as const;

// A reason a run fails before its adapter is called. It ends the run as failed, like an adapter's own failure.
class RunRefused extends Error {}

interface Counts {
  found: number;
  newOrChanged: number;
  unchanged: number;
}

export class DiscoveryService implements Discovery {
  readonly #repository: DiscoveryRepository;
  readonly #catalogue: Catalogue;
  readonly #fetchers: Map<string, SourceFetcher>;
  readonly #settings: DiscoverySettings;
  readonly #logger: Logger;
  readonly #clock: Clock;

  constructor(deps: {
    repository: DiscoveryRepository;
    catalogue: Catalogue;
    fetchers: SourceFetcher[];
    settings: DiscoverySettings;
    logger: Logger;
    clock?: Clock;
  }) {
    this.#repository = deps.repository;
    this.#catalogue = deps.catalogue;
    this.#fetchers = new Map(deps.fetchers.map((fetcher) => [fetcher.kind, fetcher]));
    this.#settings = deps.settings;
    this.#logger = deps.logger.child({ domain: "discovery" });
    this.#clock = deps.clock ?? (() => new Date());
  }

  async saveSource(input: SaveSourceInput): Promise<Source> {
    if (!(SOURCE_KINDS as readonly string[]).includes(input.kind)) {
      throw new AppError("invalid_input", `Unknown source kind "${input.kind}".`, [
        { path: "kind", message: `Must be one of ${SOURCE_KINDS.join(", ")}.` },
      ]);
    }

    // Locations are Catalogue's, so the source's location is found through the Catalogue service.
    const location = await this.#catalogue.getLocation({ slug: input.locationSlug });
    if (!location) {
      throw new AppError("not_found", `No location with the slug "${input.locationSlug}".`, [
        { path: "locationSlug", message: "No such location." },
      ]);
    }

    const source = await this.#repository.upsertSource({
      name: input.name,
      kind: input.kind,
      locationId: location.id,
      settings: input.settings ?? {},
      credentialsSetting: input.credentialsSetting ?? null,
      priority: input.priority ?? 0,
      fetchIntervalHours: input.fetchIntervalHours ?? this.#settings.defaultFetchIntervalHours,
      missedRunsBeforeRemoval: input.missedRunsBeforeRemoval ?? this.#settings.defaultMissedRunsBeforeRemoval,
      maxProcessingAttempts: input.maxProcessingAttempts ?? this.#settings.defaultMaxProcessingAttempts,
      active: input.active ?? true,
    });

    this.#logger.info(
      { sourceId: source.id, name: source.name, kind: source.kind, location: location.slug },
      "Source saved",
    );
    return source;
  }

  listSources(): Promise<Source[]> {
    return this.#repository.listSources();
  }

  async findDueSources(): Promise<Source[]> {
    const now = this.#clock();
    // A run that crashed never blocks its source: past the run timeout it is closed as failed.
    await this.#closeStaleRuns(now);
    const active = (await this.#repository.listSources()).filter((source) => source.active);
    const lastRuns = await this.#repository.findLastRuns(active.map((source) => source.id));
    const due = active.filter((source) =>
      isDue({ fetchIntervalHours: source.fetchIntervalHours, lastRun: lastRuns[source.id] ?? null }, now),
    );
    this.#logger.debug({ active: active.length, due: due.length }, "Found the sources that are due");
    return due;
  }

  async runSource(sourceId: string): Promise<RunSummary> {
    const source = await this.#repository.findSource(sourceId);
    if (!source) throw new AppError("not_found", `No source with the ID "${sourceId}".`);
    const location = await this.#catalogue.getLocation({ id: source.locationId });
    if (!location) throw new Error(`Source ${source.id} has a location Catalogue does not have: ${source.locationId}`);

    await this.#closeStaleRuns(this.#clock(), source.id);
    const last = (await this.#repository.findLastRuns([source.id]))[source.id] ?? null;
    if (last?.status === "running") {
      // Never two fetches of one source at once. The run in progress is left alone.
      this.#logger.warn(
        { sourceId: source.id, source: source.name, runId: last.id },
        "The source is already being fetched",
      );
      return {
        runId: last.id,
        sourceId: source.id,
        sourceName: source.name,
        status: "failed",
        complete: false,
        listingsFound: 0,
        listingsNewOrChanged: 0,
        listingsUnchanged: 0,
        listingsRemoved: 0,
        error: "The source is already being fetched.",
      };
    }

    const startedAt = this.#clock();
    const runId = await this.#repository.startRun(source.id, startedAt);
    const logger = this.#logger.child({ sourceId: source.id, source: source.name, kind: source.kind, runId });
    logger.debug({}, "Run started");

    const counts: Counts = { found: 0, newOrChanged: 0, unchanged: 0 };
    let complete = false;
    let error: string | null = null;
    // Listings saved before a failure stay saved: each one is saved on its own, not in one transaction for the run.
    try {
      const result = await this.#fetch(source, location, startedAt, logger);
      complete = result.complete;
      await this.#saveListings(source, runId, result.listings, counts, logger);
      // Saved only once every listing is, so an adapter that fetches incrementally never skips one that was lost.
      await this.#repository.saveSyncState(source.id, result.syncState);
    } catch (caught) {
      error = errorMessage(caught);
    }

    const status = error === null ? "succeeded" : "failed";
    await this.#repository.finishRun(runId, {
      status,
      complete,
      listingsFound: counts.found,
      listingsNewOrChanged: counts.newOrChanged,
      listingsUnchanged: counts.unchanged,
      error,
      finishedAt: this.#clock(),
    });
    if (error !== null) logger.warn({ error }, "The run failed");

    // Only a successful, complete run says what the source no longer lists. A feed or an incremental fetch does not.
    let removed = 0;
    if (status === "succeeded" && complete) {
      const missed = await this.#repository.findMissedListings(source.id, source.missedRunsBeforeRemoval);
      if (missed.length > 0) await this.#repository.removeListings(missed, runId, this.#clock());
      removed = missed.length;
    }

    const summary: RunSummary = {
      runId,
      sourceId: source.id,
      sourceName: source.name,
      status,
      complete,
      listingsFound: counts.found,
      listingsNewOrChanged: counts.newOrChanged,
      listingsUnchanged: counts.unchanged,
      listingsRemoved: removed,
      error,
    };
    logger.info(
      {
        status,
        complete,
        found: counts.found,
        newOrChanged: counts.newOrChanged,
        unchanged: counts.unchanged,
        removed,
        durationMs: this.#clock().getTime() - startedAt.getTime(),
      },
      "Run finished",
    );
    return summary;
  }

  async claimPendingRawListing(): Promise<ClaimedRawListing | null> {
    // Each round either returns the latest version of a listing or supersedes an older one, so it ends.
    for (;;) {
      const locked = await this.#repository.lockOldestPendingRawListing();
      if (!locked) return null;
      const { rawListing, latestRawListingId } = locked;

      // Only the latest version of a listing is processed, so old values never go back over newer ones.
      const superseded = await this.#repository.supersedeOlderVersions({
        listingId: rawListing.listingId,
        newerRawListingId: latestRawListingId,
      });
      if (superseded.length > 0) {
        this.#logger.debug(
          { listingId: rawListing.listingId, superseded, newerRawListingId: latestRawListingId },
          "Older versions of a listing superseded",
        );
      }
      if (latestRawListingId !== rawListing.id) continue;

      this.#logger.debug(
        { rawListingId: rawListing.id, listingId: rawListing.listingId, source: rawListing.source.name },
        "Raw listing claimed",
      );
      return rawListing;
    }
  }

  async markRawListingProcessed(rawListingId: string): Promise<void> {
    const rawListing = await this.#pending(rawListingId);
    await this.#repository.markRawListingProcessed({ id: rawListing.id, listingId: rawListing.listingId });
    this.#logger.info({ rawListingId, listingId: rawListing.listingId }, "Raw listing processed");
  }

  async markRawListingFailed(rawListingId: string, error: string): Promise<{ attempts: number; willRetry: boolean }> {
    const rawListing = await this.#pending(rawListingId);
    const attempts = rawListing.attempts + 1;
    // Back to pending while attempts are below the source's max, then failed for good.
    const willRetry = attempts < rawListing.maxProcessingAttempts;
    await this.#repository.markRawListingFailed({
      id: rawListing.id,
      listingId: rawListing.listingId,
      attempts,
      error,
      willRetry,
    });
    this.#logger.info({ rawListingId, listingId: rawListing.listingId, attempts, willRetry }, "Raw listing failed");
    return { attempts, willRetry };
  }

  async getListingPriorities(listingIds: string[]): Promise<Record<string, number>> {
    if (listingIds.length === 0) return {};
    return this.#repository.findListingPriorities([...new Set(listingIds)]);
  }

  async #closeStaleRuns(now: Date, sourceId?: string): Promise<void> {
    const closed = await this.#repository.closeStaleRuns({
      ...(sourceId === undefined ? {} : { sourceId }),
      startedBefore: staleBefore(now, this.#settings.runTimeoutMinutes),
      finishedAt: now,
      error: "The run did not finish.",
    });
    if (closed > 0) this.#logger.warn({ closed, sourceId }, "Closed runs that did not finish as failed");
  }

  async #fetch(source: SourceForRun, location: Location, now: Date, logger: Logger): Promise<FetchResult> {
    const fetcher = this.#fetchers.get(source.kind);
    if (!fetcher) throw new RunRefused(`No adapter fetches sources of the kind "${source.kind}".`);

    let credentials: string | undefined;
    if (source.credentialsSetting !== null) {
      credentials = this.#settings.credentials[source.credentialsSetting];
      if (credentials === undefined || credentials === "") {
        throw new RunRefused(`The setting ${source.credentialsSetting}, which holds this source's API key, is not set.`);
      }
    }

    const window = sourcingWindow(now, location.timezone, this.#settings.horizonMonths);
    logger.debug({ window }, "Fetching");
    return fetcher.fetch({
      settings: source.settings,
      ...(credentials === undefined ? {} : { credentials }),
      location,
      syncState: source.syncState,
      window,
    });
  }

  // New: a listing record and its first raw listing. Changed, or back after it was removed: a new raw listing.
  // Unchanged: only its last seen.
  async #saveListings(
    source: SourceForRun,
    runId: string,
    listings: FetchedListing[],
    counts: Counts,
    logger: Logger,
  ): Promise<void> {
    const known = new Map((await this.#repository.findListings(source.id)).map((one) => [one.sourceListingId, one]));
    const seen = new Set<string>();
    const unchanged: string[] = [];
    try {
      for (const listing of listings) {
        // A feed's pages can overlap when new posts push old ones down, so one listing can come back twice.
        if (seen.has(listing.sourceListingId)) continue;
        seen.add(listing.sourceListingId);
        counts.found += 1;

        const version = {
          runId,
          url: listing.url ?? null,
          contentType: listing.contentType,
          content: listing.content,
          fingerprint: fingerprint(listing),
          fetchedAt: this.#clock(),
        };
        const record = known.get(listing.sourceListingId);
        if (!record) {
          await this.#repository.saveNewListing({
            sourceId: source.id,
            sourceListingId: listing.sourceListingId,
            ...version,
          });
          counts.newOrChanged += 1;
        } else if (record.fingerprint === version.fingerprint && record.state === "listed") {
          unchanged.push(record.id);
          counts.unchanged += 1;
        } else {
          await this.#repository.saveListingVersion({ listingId: record.id, ...version });
          counts.newOrChanged += 1;
          if (record.state === "removed") {
            logger.info({ listingId: record.id, sourceListingId: listing.sourceListingId }, "A removed listing is back");
          }
        }
      }
    } finally {
      await this.#repository.markListingsSeen(unchanged, runId);
    }
  }

  async #pending(rawListingId: string): Promise<RawListingForMark> {
    const rawListing = await this.#repository.findRawListingForMark(rawListingId);
    if (!rawListing) throw new AppError("not_found", `No raw listing with the ID "${rawListingId}".`);
    if (rawListing.status !== "pending") {
      throw new Error(`Raw listing ${rawListingId} is ${rawListing.status}; only a pending one can be marked`);
    }
    return rawListing;
  }
}
