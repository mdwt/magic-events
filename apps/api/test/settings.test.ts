import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSettings } from "../src/adapters/settings/env.ts";

// The settings provider, with no database.

const REQUIRED = {
  DATABASE_URL: "postgres://magic:magic@localhost:5434/magic_events",
  BETTER_AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
};

test("the defaults apply when only the required variables are set", () => {
  const settings = loadSettings(REQUIRED);
  assert.deepEqual(settings, {
    api: {
      host: "0.0.0.0",
      port: 4000,
      corsOrigin: "http://localhost:3000",
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      logLevel: "info",
      logPretty: false,
      rateLimitMax: 300,
      rateLimitWindowSeconds: 60,
      bodyLimitBytes: 65536,
    },
    database: { url: REQUIRED.DATABASE_URL },
    identity: { authSecret: REQUIRED.BETTER_AUTH_SECRET, apiKeyRateLimitMax: 120, apiKeyRateLimitWindowSeconds: 60 },
    catalogue: { searchDefaultRadiusKm: 25, searchMaxRadiusKm: 200 },
    discovery: { defaultFetchIntervalHours: 168, defaultMissedRunsBeforeRemoval: 3, defaultMaxProcessingAttempts: 3 },
  });
});

test("given values are parsed, and an empty value counts as not set", () => {
  const settings = loadSettings({
    ...REQUIRED,
    API_PORT: "8080",
    LOG_LEVEL: "debug",
    LOG_PRETTY: "true",
    API_ALLOWED_HOSTS: " api.example.com , localhost ",
    CORS_ORIGIN: "https://app.example.com/",
    API_KEY_RATE_LIMIT_MAX: "",
    SEARCH_MAX_RADIUS_KM: "150.5",
  });
  assert.equal(settings.api.port, 8080);
  assert.equal(settings.api.logLevel, "debug");
  assert.equal(settings.api.logPretty, true);
  assert.deepEqual(settings.api.allowedHosts, ["api.example.com", "localhost"]);
  assert.equal(settings.api.corsOrigin, "https://app.example.com");
  assert.equal(settings.identity.apiKeyRateLimitMax, 120);
  assert.equal(settings.catalogue.searchMaxRadiusKm, 150.5);
});

test("a missing required variable stops startup and is named", () => {
  assert.throws(() => loadSettings({ DATABASE_URL: REQUIRED.DATABASE_URL }), /BETTER_AUTH_SECRET: Required\./);
  assert.throws(() => loadSettings({ BETTER_AUTH_SECRET: REQUIRED.BETTER_AUTH_SECRET }), /DATABASE_URL: Required\./);
});

test("each invalid value stops startup and names its variable", () => {
  const invalid: Record<string, string> = {
    DATABASE_URL: "mysql://localhost/db",
    BETTER_AUTH_SECRET: "too short",
    API_PORT: "70000",
    LOG_LEVEL: "loud",
    LOG_PRETTY: "yes",
    API_RATE_LIMIT_MAX: "0",
    API_BODY_LIMIT_BYTES: "abc",
    CORS_ORIGIN: "not a url",
    API_KEY_RATE_LIMIT_WINDOW_SECONDS: "99999999",
    SEARCH_DEFAULT_RADIUS_KM: "-5",
  };
  for (const [name, value] of Object.entries(invalid)) {
    assert.throws(() => loadSettings({ ...REQUIRED, [name]: value }), new RegExp(`The settings .*\\n  ${name}: `), name);
  }
});

test("the default radius may not be larger than the largest", () => {
  assert.throws(
    () => loadSettings({ ...REQUIRED, SEARCH_DEFAULT_RADIUS_KM: "300" }),
    /SEARCH_DEFAULT_RADIUS_KM: Must not be larger than SEARCH_MAX_RADIUS_KM/,
  );
});
