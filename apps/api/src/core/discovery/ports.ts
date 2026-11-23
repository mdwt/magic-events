import type { Location } from "../catalogue/ports.ts";

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

// ---- Ports ----

// Inbound port: what Discovery offers.
export interface Discovery {
  // Creates the source, or updates the one that has this name in this location.
  saveSource(input: SaveSourceInput): Promise<Source>;
  listSources(): Promise<Source[]>;
  // Fetches every active source whose fetch interval has passed since its last run started.
  runDueSources(): Promise<RunSummary[]>;
  // Fetches one source now, whether or not it is due. A fetch that fails is a failed run, not a thrown error.
  runSource(sourceId: string): Promise<RunSummary>;
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

// Outbound port: what Discovery needs from storage.
export interface DiscoveryRepository {
  upsertSource(input: Omit<Source, "id">): Promise<Source>;
}
