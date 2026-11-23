import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { apikey, user } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { logContext } from "@magic-events/core/shared/log-context.ts";
import { testOverrides, testSettings } from "@magic-events/core/testing/harness.ts";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";
import { registeredRoutes } from "./helpers/routes.ts";

// Every route the server registers, read from the server itself, needs a valid API key, but the health check and the
// CORS preflight. A route added later is covered here without anyone adding it to a list.

let harness: Harness;
let key: string;
// Keys that must each be refused with 401 everywhere.
const refused: Record<string, Record<string, string>> = {};

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });

// The routes anyone may call. The catch-all OPTIONS route is @fastify/cors's, which answers a preflight.
const PUBLIC = new Set(["GET /health", "HEAD /health", "OPTIONS *"]);

const MCP_HEADERS = { accept: "application/json, text/event-stream" };

// A request to the route, with its parameters filled in and a body for a method that takes one.
function requestTo(route: { method: string; url: string }, headers: Record<string, string>) {
  const url = route.url.replace(/:\w+/g, "something").replace("*", "anything");
  const body = ["POST", "PUT", "PATCH"].includes(route.method) ? { payload: {} } : {};
  return harness.app.inject({ method: route.method as "GET", url, headers: { ...MCP_HEADERS, ...headers }, ...body });
}

function assertRefused(response: LightMyRequestResponse, what: string): void {
  assert.equal(response.statusCode, 401, what);
  assert.match(String(response.headers["www-authenticate"]), /^Bearer realm="magic-events"/, what);
  if (response.body !== "") assert.equal(response.json<{ error: { code: string } }>().error.code, "unauthenticated", what);
}

before(async () => {
  harness = await createHarness();
  ({ key } = await harness.createCaller());

  const revoked = await harness.createCaller();
  const [credential] = await harness.services.identity.listCredentials(revoked.userId);
  await harness.services.identity.revokeCredential(revoked.userId, credential?.id ?? "");
  const expired = await harness.createCaller();
  await harness.db.update(apikey).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apikey.referenceId, expired.userId));
  const deleted = await harness.createCaller();
  await harness.db.delete(user).where(eq(user.id, deleted.userId));

  Object.assign(refused, {
    "no key": {},
    "an empty bearer": { authorization: "Bearer " },
    "another scheme": { authorization: `Basic ${key}` },
    "a key and more after it": { authorization: `Bearer ${key} more` },
    "an unknown key": bearer("mev_unknown"),
    "an unknown key in x-api-key": { "x-api-key": "mev_unknown" },
    "a revoked key": bearer(revoked.key),
    "an expired key": bearer(expired.key),
    "the key of a user who is gone": bearer(deleted.key),
    "the key with a character added": bearer(`${key}x`),
    "the key with a character added, in x-api-key": { "x-api-key": `${key}x` },
    "the key with its last character dropped": bearer(key.slice(0, -1)),
    "a wrong Authorization beside a good x-api-key": { ...bearer("mev_unknown"), "x-api-key": key },
  });
});

after(() => harness.close());

describe("every route the server registers", () => {
  test("is found in the server's route tree, the client endpoints and MCP among them", () => {
    const names = registeredRoutes(harness.app).map((route) => `${route.method} ${route.url}`);
    for (const name of ["GET /health", "GET /openapi.json", "POST /mcp", "POST /v1/experiences/search", "POST /v1/experiences/changes"]) {
      assert.ok(names.includes(name), `${name} is not in the route tree`);
    }
  });

  test("answers 401 with WWW-Authenticate to every bad key, but /health and the CORS preflight", async () => {
    for (const route of registeredRoutes(harness.app)) {
      if (PUBLIC.has(`${route.method} ${route.url}`)) continue;
      for (const [what, headers] of Object.entries(refused)) {
        assertRefused(await requestTo(route, headers), `${route.method} ${route.url} with ${what}`);
      }
    }
  });

  test("lets a valid key past authentication, over Authorization and over x-api-key", async () => {
    for (const route of registeredRoutes(harness.app)) {
      if (PUBLIC.has(`${route.method} ${route.url}`)) continue;
      for (const headers of [bearer(key), { authorization: `bearer ${key}` }, { "x-api-key": key }]) {
        const response = await requestTo(route, headers);
        assert.ok(![401, 403].includes(response.statusCode), `${route.method} ${route.url} answered ${response.statusCode}`);
      }
    }
  });

  test("never takes the key from the address", async () => {
    for (const route of registeredRoutes(harness.app)) {
      if (PUBLIC.has(`${route.method} ${route.url}`)) continue;
      for (const query of [`api_key=${key}`, `key=${key}`, `access_token=${key}`]) {
        const url = `${route.url.replace(/:\w+/g, "something")}?${query}`;
        assertRefused(await requestTo({ method: route.method, url }, {}), `${route.method} ${url}`);
      }
    }
  });

  test("an address that does not exist answers 401 to every method without a key, and 404 with one", async () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const url of ["/no/such/path", "/v1/tenants", "/api/auth/api-key/verify", "/api/auth/sign-up/email", "/api/auth/get-session"]) {
        assertRefused(await requestTo({ method, url }, {}), `${method} ${url}`);
        assert.equal((await requestTo({ method, url }, bearer(key))).statusCode, 404, `${method} ${url} with a key`);
      }
    }
  });

  test("the health check and the CORS preflight answer without a key, and the preflight carries nothing", async () => {
    assert.equal((await harness.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    for (const url of ["/v1/experiences/search", "/no/such/path"]) {
      const preflight = await harness.app.inject({
        method: "OPTIONS",
        url,
        headers: { origin: "https://elsewhere.example.com", "access-control-request-method": "POST" },
      });
      assert.equal(preflight.statusCode, 204, url);
      assert.equal(preflight.body, "", url);
      // Only the configured origin is ever allowed, so a page elsewhere cannot read an answer.
      assert.equal(preflight.headers["access-control-allow-origin"], "http://localhost:3000", url);
      assert.equal(preflight.headers["access-control-allow-credentials"], undefined, url);
    }
  });
});

describe("before a caller is authenticated", () => {
  test("the server neither reads nor checks the body, so a stranger learns nothing of the schema", async () => {
    for (const one of [
      { headers: { "content-type": "application/json" }, payload: "x".repeat(200_000) },
      { headers: { "content-type": "application/json" }, payload: '{"near": ' },
      { headers: { "content-type": "text/plain" }, payload: "hello" },
      { headers: {}, payload: { colour: "blue", near: { lat: 500 } } },
    ]) {
      const response = await harness.app.inject({ method: "POST", url: "/v1/experiences/search", ...one });
      assertRefused(response, JSON.stringify(one.headers));
      assert.doesNotMatch(response.body, /colour|near|lat/);
    }
  });

  test("a 401 carries the security headers and the address's rate limit, as every answer does", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.ok(response.headers["strict-transport-security"]);
    assert.ok(response.headers["content-security-policy"]);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.ok(response.headers["x-ratelimit-limit"]);
    assert.ok(response.headers["x-ratelimit-remaining"]);
  });
});

describe("WWW-Authenticate", () => {
  test("is the bare challenge when no key was sent, and says invalid_token when one was", async () => {
    const none = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(none.headers["www-authenticate"], 'Bearer realm="magic-events"');
    const basic = await harness.app.inject({ method: "GET", url: "/openapi.json", headers: { authorization: "Basic abc" } });
    assert.equal(basic.headers["www-authenticate"], 'Bearer realm="magic-events"');
    for (const headers of [bearer("mev_unknown"), { "x-api-key": "mev_unknown" }]) {
      const sent = await harness.app.inject({ method: "GET", url: "/openapi.json", headers });
      assert.equal(sent.headers["www-authenticate"], 'Bearer realm="magic-events", error="invalid_token"');
    }
  });
});

describe("the logs", () => {
  let app: FastifyInstance;
  const lines: string[] = [];

  before(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        done();
      },
    });
    const settings = testSettings(process.env.TEST_DATABASE_URL ?? "");
    const logger = pino({ level: "trace", mixin: () => ({ ...logContext.getStore() }) }, stream);
    ({ app } = await buildApp({ settings, db: harness.db, logger, overrides: testOverrides({}) }));
    await app.ready();
  });

  after(() => app.close());

  test("never hold a key, whether it is good or bad, sent in a header or put in the address", async () => {
    for (const headers of [bearer(key), { "x-api-key": key }, bearer(`${key}x`), { "x-api-key": `${key}x` }]) {
      await app.inject({ method: "GET", url: "/openapi.json", headers });
    }
    await app.inject({ method: "GET", url: `/openapi.json?api_key=${key}` });
    await app.inject({ method: "GET", url: `/health?api_key=${key}` });
    assert.ok(lines.some((line) => line.includes("mev_[redacted]")), "the address was logged");
    const secret = key.slice("mev_".length);
    assert.equal(lines.filter((line) => line.includes(secret)).length, 0, "a line holds the key");
  });
});

describe("behind a proxy named in API_TRUST_PROXY", () => {
  const PROXY = "10.0.0.1";
  let app: FastifyInstance;
  const lines: { msg?: string; requestId?: string; address?: string }[] = [];

  before(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line) as (typeof lines)[number]);
        done();
      },
    });
    const settings = testSettings(process.env.TEST_DATABASE_URL ?? "");
    settings.api.trustProxy = [PROXY];
    settings.api.rateLimitMax = 1;
    const logger = pino({ level: "info", mixin: () => ({ ...logContext.getStore() }) }, stream);
    ({ app } = await buildApp({ settings, db: harness.db, logger, overrides: testOverrides({}) }));
    await app.ready();
  });

  after(() => app.close());

  async function call(remoteAddress: string, forwardedFor: string): Promise<{ status: number; address: string | undefined }> {
    const response = await app.inject({ method: "GET", url: "/health", remoteAddress, headers: { "x-forwarded-for": forwardedFor } });
    const line = lines.find((one) => one.msg === "Request completed" && one.requestId === response.headers["x-request-id"]);
    return { status: response.statusCode, address: line?.address };
  }

  test("from the proxy, X-Forwarded-For is the address the limit counts and the log shows", async () => {
    assert.deepEqual(await call(PROXY, "203.0.113.5"), { status: 200, address: "203.0.113.5" });
    assert.deepEqual(await call(PROXY, "203.0.113.5"), { status: 429, address: "203.0.113.5" });
    // Another caller through the same proxy has a limit of its own.
    assert.deepEqual(await call(PROXY, "203.0.113.6"), { status: 200, address: "203.0.113.6" });
  });

  test("from any other address, X-Forwarded-For is ignored", async () => {
    assert.deepEqual(await call("198.51.100.7", "203.0.113.9"), { status: 200, address: "198.51.100.7" });
    // A new X-Forwarded-For does not buy a new limit.
    assert.deepEqual(await call("198.51.100.7", "203.0.113.10"), { status: 429, address: "198.51.100.7" });
  });
});
