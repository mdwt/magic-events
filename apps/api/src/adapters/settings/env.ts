import { z } from "zod";
import type { Settings } from "../../core/shared/settings.ts";

// The settings provider: the environment, read once at startup, with defaults applied. An invalid value stops the
// system with a message that names the variable. No other code reads process.env.

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const whole = (min: number) => z.coerce.number().int().min(min);

const flag = z.enum(["true", "false"], { error: 'Must be "true" or "false".' }).transform((value) => value === "true");

const list = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(z.string()).min(1, "Must name at least one value."));

const environmentSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "Must be a postgres:// URL." }),
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: whole(1).max(65535).default(4000),
  CORS_ORIGIN: z.url({ protocol: /^https?$/, error: "Must be an http:// or https:// origin." }).default("http://localhost:3000"),
  API_ALLOWED_HOSTS: list.default(["localhost", "127.0.0.1", "[::1]"]),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  LOG_PRETTY: flag.default(false),
  API_RATE_LIMIT_MAX: whole(1).default(300),
  API_RATE_LIMIT_WINDOW_SECONDS: whole(1).default(60),
  API_BODY_LIMIT_BYTES: whole(1024).default(65536),
  BETTER_AUTH_SECRET: z.string().min(32, "Must be at least 32 characters."),
  API_KEY_RATE_LIMIT_MAX: whole(1).default(120),
  // The key's window is stored in milliseconds in a 32-bit column, which holds a little over 24 days.
  API_KEY_RATE_LIMIT_WINDOW_SECONDS: whole(1).max(2_073_600, "Must be at most 24 days, in seconds.").default(60),
  SEARCH_DEFAULT_RADIUS_KM: z.coerce.number().positive().default(25),
  SEARCH_MAX_RADIUS_KM: z.coerce.number().positive().default(200),
  DISCOVERY_DEFAULT_FETCH_INTERVAL_HOURS: whole(1).default(168),
  DISCOVERY_DEFAULT_MISSED_RUNS_BEFORE_REMOVAL: whole(1).default(3),
  DISCOVERY_DEFAULT_MAX_PROCESSING_ATTEMPTS: whole(1).default(3),
  DISCOVERY_SCHEDULE_INTERVAL_SECONDS: whole(1).default(60),
  DISCOVERY_FETCH_TIMEOUT_SECONDS: whole(1).default(30),
  DISCOVERY_HORIZON_MONTHS: whole(1).default(24),
  QUICKET_API_KEY: z.string().min(1).optional(),
  TICKETMASTER_API_KEY: z.string().min(1).optional(),
  CATALOGUE_SESSION_HORIZON_MONTHS: whole(1).default(24),
  PROCESSING_IDLE_INTERVAL_SECONDS: whole(1).default(30),
  PROCESSING_WORKERS: whole(1).default(1),
  LANGUAGE_MODEL_PROVIDER: z.enum(["anthropic"]).default("anthropic"),
  LANGUAGE_MODEL: z.string().min(1).default("claude-opus-5-5"),
  LANGUAGE_MODEL_TIMEOUT_SECONDS: whole(1).default(120),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
});

const VARIABLES = Object.keys(environmentSchema.shape);

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  // A variable that is set but empty, as in a copied .env.example, counts as not set.
  const given = Object.fromEntries(VARIABLES.map((name) => [name, env[name] === "" ? undefined : env[name]]));
  const parsed = environmentSchema.safeParse(given);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join(".");
      return `  ${name}: ${given[name] === undefined ? "Required." : issue.message}`;
    });
    throw new Error(`The settings in the environment are not valid:\n${problems.join("\n")}`);
  }

  const e = parsed.data;
  if (e.SEARCH_DEFAULT_RADIUS_KM > e.SEARCH_MAX_RADIUS_KM) {
    throw new Error(
      "The settings in the environment are not valid:\n  SEARCH_DEFAULT_RADIUS_KM: Must not be larger than SEARCH_MAX_RADIUS_KM.",
    );
  }

  return {
    api: {
      host: e.API_HOST,
      port: e.API_PORT,
      corsOrigin: new URL(e.CORS_ORIGIN).origin,
      allowedHosts: e.API_ALLOWED_HOSTS,
      logLevel: e.LOG_LEVEL,
      logPretty: e.LOG_PRETTY,
      rateLimitMax: e.API_RATE_LIMIT_MAX,
      rateLimitWindowSeconds: e.API_RATE_LIMIT_WINDOW_SECONDS,
      bodyLimitBytes: e.API_BODY_LIMIT_BYTES,
    },
    database: { url: e.DATABASE_URL },
    identity: {
      authSecret: e.BETTER_AUTH_SECRET,
      apiKeyRateLimitMax: e.API_KEY_RATE_LIMIT_MAX,
      apiKeyRateLimitWindowSeconds: e.API_KEY_RATE_LIMIT_WINDOW_SECONDS,
    },
    catalogue: {
      searchDefaultRadiusKm: e.SEARCH_DEFAULT_RADIUS_KM,
      searchMaxRadiusKm: e.SEARCH_MAX_RADIUS_KM,
      sessionHorizonMonths: e.CATALOGUE_SESSION_HORIZON_MONTHS,
    },
    discovery: {
      defaultFetchIntervalHours: e.DISCOVERY_DEFAULT_FETCH_INTERVAL_HOURS,
      defaultMissedRunsBeforeRemoval: e.DISCOVERY_DEFAULT_MISSED_RUNS_BEFORE_REMOVAL,
      defaultMaxProcessingAttempts: e.DISCOVERY_DEFAULT_MAX_PROCESSING_ATTEMPTS,
      scheduleIntervalSeconds: e.DISCOVERY_SCHEDULE_INTERVAL_SECONDS,
      fetchTimeoutSeconds: e.DISCOVERY_FETCH_TIMEOUT_SECONDS,
      horizonMonths: e.DISCOVERY_HORIZON_MONTHS,
      credentials: { QUICKET_API_KEY: e.QUICKET_API_KEY, TICKETMASTER_API_KEY: e.TICKETMASTER_API_KEY },
    },
    processing: {
      idleIntervalSeconds: e.PROCESSING_IDLE_INTERVAL_SECONDS,
      workers: e.PROCESSING_WORKERS,
      horizonMonths: e.DISCOVERY_HORIZON_MONTHS,
    },
    languageModel: {
      provider: e.LANGUAGE_MODEL_PROVIDER,
      model: e.LANGUAGE_MODEL,
      timeoutSeconds: e.LANGUAGE_MODEL_TIMEOUT_SECONDS,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      anthropicEffort: e.ANTHROPIC_EFFORT,
    },
  };
}
