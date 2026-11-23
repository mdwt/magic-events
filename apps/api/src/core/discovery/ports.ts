import type { Location } from "../catalogue/ports.ts";
import type { DomainEvent } from "../shared/domain-events.ts";
import type { LastRun } from "./due.ts";

export type { LastRun };

// Discovery: finds experiences and captures the raw data as received.
// Every source belongs to one location, and locations are Catalogue's. Discovery gets a source's location by
// asking the Catalogue service, and never reads the location table itself. Catalogue is the only domain it calls.

// ---- Sources ----

export interface Source {
  id: string;
  name: string;
  // Picks the adapter that fetches it and the extractor that reads it: quicket, ticketmaster, rss_feed, pdf_calendar, web_page.
  kind: string;
  locationId: string;
  settings: Record<string, unknown>;
  // The name of the setting that holds the API key. The key itself is never stored.
  credentialsSetting: string | null;
  priority: number;
  fetchIntervalHours: number;
  missedRunsBeforeRemoval: number;
  maxProcessingAttempts: number;
  active: boolean;
}

export interface SaveSourceInput {
  name: string;
  kind: string;
  // The slug of the source's one location.
  locationSlug: string;
  settings?: Record<string, unknown>;
  credentialsSetting?: string;
  priority?: number;
  // Left out, these three take the defaults from the settings.
  fetchIntervalHours?: number;
  missedRunsBeforeRemoval?: number;
  maxProcessingAttempts?: number;
  active?: boolean;
}

// ---- Fetching ----

// One item a source publishes, whole and exactly as returned: one API event, one web page, one post or one calendar.
export interface FetchedListing {
  // The source's own ID for the listing, or its web address. Stable across runs, unique within the source.
  sourceListingId: string;
  url?: string;
  // application/json, text/html, application/xml or application/pdf
  contentType: string;
  // Exactly as returned. A PDF as base64.
  content: string;
  // What the fingerprint is taken from when the content itself changes on every fetch, such as a web page's
  // visible text. Left out, the fingerprint is taken from the content.
  fingerprintOf?: string;
}

export interface FetchInput {
  // The source's settings JSON. Each kind defines its own.
  settings: Record<string, unknown>;
  // The API key, from the settings provider, by the setting the source names.
  credentials?: string;
  // The source's location, from the Catalogue service.
  location: Location;
  // What this adapter saved at the end of its last run.
  syncState: Record<string, unknown>;
  // The sourcing window, as YYYY-MM-DD: today to the horizon. An adapter whose source takes dates asks for this.
  window: { from: string; to: string };
}

export interface FetchResult {
  listings: FetchedListing[];
  // True when this run returned everything the source currently lists.
  complete: boolean;
  // Saved on the source for the next run.
  syncState: Record<string, unknown>;
}

// Outbound port: one per source kind. An adapter fetches and returns each listing whole. It does not clean,
// split or interpret anything.
export interface SourceFetcher {
  readonly kind: string;
  fetch(input: FetchInput): Promise<FetchResult>;
}

// One fetch of one source, as it ended.
export interface RunSummary {
  runId: string;
  sourceId: string;
  sourceName: string;
  status: "succeeded" | "failed";
  complete: boolean;
  listingsFound: number;
  listingsNewOrChanged: number;
  listingsUnchanged: number;
  // Listings that this run found to be gone from the source.
  listingsRemoved: number;
  error: string | null;
}

// ---- Hand-off to Data processing ----

// A pending raw listing, claimed for processing, with what Data processing needs to know about its source.
export interface ClaimedRawListing {
  id: string;
  listingId: string;
  // "removed" means the listing is gone from the source, and there is no content.
  kind: "listing" | "removed";
  source: { id: string; name: string; kind: string; priority: number; locationId: string };
  url: string | null;
  contentType: string | null;
  content: string | null;
  // When this version was fetched, as an ISO timestamp.
  fetchedAt: string;
  attempts: number;
}

// ---- Processing again ----

// The listings to send back for processing: some by ID, every listing of a source, or every listing of a location.
export type ListingSelection = { listingIds: string[] } | { sourceId: string } | { locationId: string };

export interface RequeueResult {
  // How many listings had their latest version set back to pending.
  requeued: number;
  listingIds: string[];
}

// A listing with the source it belongs to.
export interface ListingSummary {
  id: string;
  sourceId: string;
  sourceName: string;
  url: string | null;
  state: "listed" | "removed";
}

// ---- Ports ----

// Inbound port: what Discovery offers.
export interface Discovery {
  // Creates the source, or updates the one that has this name in this location.
  saveSource(input: SaveSourceInput): Promise<Source>;
  listSources(): Promise<Source[]>;
  // The active sources that are due a fetch: never fetched, or one fetch interval since the last run started.
  // A source that is being fetched now is not due. Trying a failed fetch again is the job queue's work, not this.
  findDueSources(): Promise<Source[]>;
  // Fetches one source now, whether or not it is due. A fetch that fails is a failed run, not a thrown error.
  runSource(sourceId: string): Promise<RunSummary>;
  // Fetches every active source of the location now, one after another, whether or not it is due.
  runLocation(locationSlug: string): Promise<RunSummary[]>;
  // A listing with its source, or null when there is none with this ID. A listing is fetched by fetching its source.
  getListing(listingId: string): Promise<ListingSummary | null>;
  // Sends listings back for processing: the latest version of each selected listing that is listed goes back to
  // pending, with its attempts at 0 and its error cleared. A latest version that is already pending is left as it
  // is and not counted. A listing that is removed, or whose latest version is of kind removed, is skipped.
  requeueListings(selection: ListingSelection): Promise<RequeueResult>;
  // Claims the next pending raw listing, or returns null when none is pending. Only the latest version of a
  // listing is claimed; older pending or failed versions are set to superseded. It must be called inside a
  // transaction, which holds the claim until it ends, so two workers never get the same one.
  claimPendingRawListing(): Promise<ClaimedRawListing | null>;
  markRawListingProcessed(rawListingId: string): Promise<void>;
  // Records the error and one more attempt. The raw listing goes back to pending until it reaches its source's
  // max processing attempts, then stays failed.
  markRawListingFailed(rawListingId: string, error: string): Promise<{ attempts: number; willRetry: boolean }>;
  // The priority of each listing's source, by listing ID, for when sources disagree.
  getListingPriorities(listingIds: string[]): Promise<Record<string, number>>;
}

// ---- Storage ----

// A source as a run needs it: with the sync state its adapter kept from the last run.
export interface SourceForRun extends Source {
  syncState: Record<string, unknown>;
}

// What Discovery knows of a listing when a run returns it again.
export interface KnownListing {
  id: string;
  sourceListingId: string;
  fingerprint: string;
  state: "listed" | "removed";
}

// One version of a listing's content, to be saved as a pending raw listing.
export interface ListingVersion {
  runId: string;
  url: string | null;
  contentType: string;
  content: string;
  fingerprint: string;
  fetchedAt: Date;
}

export interface RunOutcome {
  status: "succeeded" | "failed";
  complete: boolean;
  listingsFound: number;
  listingsNewOrChanged: number;
  listingsUnchanged: number;
  error: string | null;
  finishedAt: Date;
}

// The oldest pending raw listing, locked for this transaction, with the ID of its listing's latest version.
export interface LockedRawListing {
  rawListing: ClaimedRawListing;
  latestRawListingId: string;
}

// A raw listing as marking it needs it.
export interface RawListingForMark {
  id: string;
  listingId: string;
  status: "pending" | "processed" | "failed" | "superseded";
  attempts: number;
  maxProcessingAttempts: number;
}

type Captured = DomainEvent<"raw_listing.captured">;

// Outbound port: what Discovery needs from storage. Each method that saves a raw listing, or changes its status,
// appends the domain event for it in the same transaction and returns the event as stored. It does not publish it.
export interface DiscoveryRepository {
  upsertSource(input: Omit<Source, "id">): Promise<Source>;
  listSources(): Promise<Source[]>;
  findSource(sourceId: string): Promise<SourceForRun | null>;
  // Each source's most recent run, by source ID, or null for a source that has never run.
  findLastRuns(sourceIds: string[]): Promise<Record<string, LastRun | null>>;
  // Closes runs still running that started before `startedBefore` as failed with the error, in one statement:
  // those of one source, or of every source when none is named. Returns how many it closed.
  closeStaleRuns(input: { sourceId?: string; startedBefore: Date; finishedAt: Date; error: string }): Promise<number>;
  saveSyncState(sourceId: string, syncState: Record<string, unknown>): Promise<void>;

  startRun(sourceId: string, startedAt: Date): Promise<string>;
  finishRun(runId: string, outcome: RunOutcome): Promise<void>;

  findListings(sourceId: string): Promise<KnownListing[]>;
  // Creates the listing, first and last seen by the version's run, with its first raw listing.
  saveNewListing(input: { sourceId: string; sourceListingId: string } & ListingVersion): Promise<Captured>;
  // Saves a new version of a listing: its fingerprint, last seen and state listed, with a new raw listing.
  saveListingVersion(input: { listingId: string } & ListingVersion): Promise<Captured>;
  // Sets the last seen run of listings that came back unchanged.
  markListingsSeen(listingIds: string[], runId: string): Promise<void>;
  // Listed listings of the source that at least `missedRuns` successful, complete runs have started after the
  // run that last saw them.
  findMissedListings(sourceId: string, missedRuns: number): Promise<string[]>;
  // Sets the listings to removed, each with a pending raw listing of kind removed, all in one transaction.
  removeListings(listingIds: string[], runId: string, removedAt: Date): Promise<Captured[]>;
  findListing(listingId: string): Promise<ListingSummary | null>;
  // The IDs among these that name a listing.
  findListingIds(listingIds: string[]): Promise<string[]>;
  // In one statement: sets the latest version of every selected listing that is listed back to pending, attempts 0
  // and no error, unless that version is already pending or of kind removed. Returns the IDs of those listings.
  requeueLatestVersions(selection: ListingSelection): Promise<string[]>;

  // Must be called inside a transaction, which holds the lock until it ends. Locked rows are skipped.
  lockOldestPendingRawListing(): Promise<LockedRawListing | null>;
  // Sets the listing's pending and failed versions other than the newer one, and older than it, to superseded.
  // Versions locked by another transaction are skipped. Returns an event for each one it set.
  supersedeOlderVersions(input: {
    listingId: string;
    newerRawListingId: string;
  }): Promise<DomainEvent<"raw_listing.superseded">[]>;
  findRawListingForMark(rawListingId: string): Promise<RawListingForMark | null>;
  markRawListingProcessed(input: { id: string; listingId: string }): Promise<DomainEvent<"raw_listing.processed">>;
  markRawListingFailed(input: {
    id: string;
    listingId: string;
    attempts: number;
    error: string;
    willRetry: boolean;
  }): Promise<DomainEvent<"raw_listing.failed">>;
  findListingPriorities(listingIds: string[]): Promise<Record<string, number>>;
}
