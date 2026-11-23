// System settings. They are read once at startup by the settings provider, which applies defaults and stops
// the system when a value is invalid. A domain is handed its own group and never reads an environment variable.

export interface ApiSettings {
  host: string;
  port: number;
  // The one browser origin allowed to call the API.
  corsOrigin: string;
  // The host names the MCP endpoint answers to, which guards it against DNS rebinding.
  allowedHosts: string[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  // Readable log lines for a person at a terminal. Off in production, where logs are JSON.
  logPretty: boolean;
  // Requests one address may make in a window, before any credential is checked.
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  bodyLimitBytes: number;
}

export interface DatabaseSettings {
  url: string;
}

export interface IdentitySettings {
  // The secret Better Auth signs and hashes with.
  authSecret: string;
  // Requests one API key may make in a window.
  apiKeyRateLimitMax: number;
  apiKeyRateLimitWindowSeconds: number;
}

export interface CatalogueSettings {
  // The radius used when a search gives none.
  searchDefaultRadiusKm: number;
  // The largest radius a search may ask for.
  searchMaxRadiusKm: number;
}

export interface DiscoverySettings {
  // The values a new source gets when it is saved without them.
  defaultFetchIntervalHours: number;
  defaultMissedRunsBeforeRemoval: number;
  defaultMaxProcessingAttempts: number;
}

export interface Settings {
  api: ApiSettings;
  database: DatabaseSettings;
  identity: IdentitySettings;
  catalogue: CatalogueSettings;
  discovery: DiscoverySettings;
}
