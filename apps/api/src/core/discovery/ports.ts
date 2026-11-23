// Discovery: finds experiences and captures the raw data as received.
// It calls Catalogue, for the location of each source.

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

// Inbound port: what Discovery offers.
export interface Discovery {
  // Creates the source, or updates the one that has this name in this location.
  saveSource(input: SaveSourceInput): Promise<Source>;
}

// Outbound port: what Discovery needs.
export interface DiscoveryRepository {
  upsertSource(input: Omit<Source, "id">): Promise<Source>;
}
