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
  // How far ahead the sessions of an open-ended recurring experience are generated.
  sessionHorizonMonths: number;
}

export interface DiscoverySettings {
  // The values a new source gets when it is saved without them.
  defaultFetchIntervalHours: number;
  defaultMissedRunsBeforeRemoval: number;
  defaultMaxProcessingAttempts: number;
  // How often the schedule looks for sources that are due a fetch.
  scheduleIntervalSeconds: number;
  // How long an adapter waits for a source to answer.
  fetchTimeoutSeconds: number;
  // How far ahead experiences are sourced.
  horizonMonths: number;
  // The API keys of sources, by the name of the setting a source row names, such as QUICKET_API_KEY.
  credentials: Record<string, string | undefined>;
}

export interface ProcessingSettings {
  // How long the processing worker waits before looking again when nothing is pending.
  idleIntervalSeconds: number;
  // How many processing workers run at once.
  workers: number;
  // The sourcing horizon: an experience that starts later than this is left out of extraction.
  horizonMonths: number;
}

export interface LanguageModelSettings {
  // Which language model adapter is used, by Data processing and Discovery.
  provider: "anthropic";
  // The model name handed to that adapter.
  model: string;
  // How long to wait for an answer.
  timeoutSeconds: number;
  // The Anthropic adapter's own settings. The key is needed only where the language model is called.
  anthropicApiKey: string | undefined;
  anthropicEffort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface Settings {
  api: ApiSettings;
  database: DatabaseSettings;
  identity: IdentitySettings;
  catalogue: CatalogueSettings;
  discovery: DiscoverySettings;
  processing: ProcessingSettings;
  languageModel: LanguageModelSettings;
}
