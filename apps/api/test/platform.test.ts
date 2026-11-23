import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { apikey, createDb } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { buildApp } from "../src/app.ts";
import { testSettings } from "@magic-events/core/testing/harness.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";

// The server end to end over app.inject: authentication on every endpoint but the health check, the error format,
// request IDs, the OpenAPI document and the MCP endpoint.

let harness: Harness;
let key: string;

before(async () => {
  harness = await createHarness();
  ({ key } = await harness.createCaller());
});

after(() => harness.close());

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });

interface ErrorBody {
  error: { code: string; message: string; details: { path: string; message: string }[]; requestId: string };
}

function errorOf(response: LightMyRequestResponse): ErrorBody["error"] {
  const body = response.json<ErrorBody>();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "details", "message", "requestId"]);
  assert.equal(body.error.requestId, response.headers["x-request-id"]);
  return body.error;
}

const SEARCH = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-06-10", to: "2027-06-20" };

const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

function mcp(body: object, headers: Record<string, string> = bearer(key)) {
  return harness.app.inject({ method: "POST", url: "/mcp", headers: { ...MCP_HEADERS, ...headers }, payload: body });
}

describe("authentication", () => {
  const routes = [
    { method: "GET", url: "/openapi.json" },
    { method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
    { method: "GET", url: "/mcp" },
    { method: "DELETE", url: "/mcp" },
    { method: "POST", url: "/v1/experiences/search", payload: SEARCH },
    { method: "GET", url: "/no/such/path" },
    { method: "POST", url: "/v1/no-such-route", payload: {} },
    { method: "POST", url: "/v1/tenants", payload: { name: "Blue", slug: "blue", kind: "travel_agency" } },
    { method: "GET", url: "/v1/tenants" },
    { method: "GET", url: "/v1/tenants/blue" },
    { method: "PATCH", url: "/v1/tenants/blue", payload: { status: "suspended" } },
    { method: "POST", url: "/v1/tenants/blue/users", payload: { name: "Ann", email: "ann@example.com" } },
    { method: "POST", url: "/v1/users/someone/credentials", payload: { name: "desk", kind: "person" } },
    { method: "GET", url: "/v1/users/someone/credentials" },
    { method: "DELETE", url: "/v1/users/someone/credentials/something" },
  ] as const;

  for (const route of routes) {
    test(`${route.method} ${route.url} answers 401 without a valid key`, async () => {
      for (const headers of [{}, bearer("mev_wrong"), { "x-api-key": "mev_wrong" }, { authorization: "Basic abc" }]) {
        const response = await harness.app.inject({ ...route, headers });
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers["www-authenticate"], 'Bearer realm="magic-events"');
        const error = errorOf(response);
        assert.equal(error.code, "unauthenticated");
        assert.deepEqual(error.details, []);
      }
    });
  }

  test("a known and an unknown path refuse a caller without a key with the same answer", async () => {
    const known = errorOf(await harness.app.inject({ method: "GET", url: "/openapi.json" }));
    const unknown = errorOf(await harness.app.inject({ method: "GET", url: "/no/such/path" }));
    assert.deepEqual({ ...known, requestId: "" }, { ...unknown, requestId: "" });
  });

  test("a valid key over Authorization or x-api-key is let in", async () => {
    for (const headers of [bearer(key), { "x-api-key": key }]) {
      const response = await harness.app.inject({ method: "GET", url: "/openapi.json", headers });
      assert.equal(response.statusCode, 200);
    }
  });

  test("the health check needs no key, and a wrong or suspended one changes nothing", async () => {
    const suspended = await harness.createCaller({ tenantStatus: "suspended" });
    for (const headers of [{}, bearer("mev_wrong"), bearer(key), bearer(suspended.key)]) {
      const response = await harness.app.inject({ method: "GET", url: "/health", headers });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: "ok" });
    }
  });

  test("with a valid key, an unknown path is not_found in the error format", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/no/such/path", headers: bearer(key) });
    assert.equal(response.statusCode, 404);
    assert.equal(errorOf(response).code, "not_found");
  });

  test("a client in a suspended tenant is forbidden everywhere", async () => {
    const suspended = await harness.createCaller({ tenantStatus: "suspended" });
    for (const route of [
      { method: "GET", url: "/openapi.json" },
      { method: "POST", url: "/v1/experiences/search", payload: SEARCH },
      { method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
    ] as const) {
      const response = await harness.app.inject({ ...route, headers: { ...MCP_HEADERS, ...bearer(suspended.key) } });
      assert.equal(response.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(errorOf(response).code, "forbidden");
    }
  });

  test("a key over its rate limit answers 429 with Retry-After", async () => {
    const limited = await harness.createCaller();
    await harness.db.update(apikey).set({ rateLimitMax: 1 }).where(eq(apikey.referenceId, limited.userId));
    const first = await harness.app.inject({ method: "GET", url: "/openapi.json", headers: bearer(limited.key) });
    assert.equal(first.statusCode, 200);
    const second = await harness.app.inject({ method: "GET", url: "/openapi.json", headers: bearer(limited.key) });
    assert.equal(second.statusCode, 429);
    assert.equal(errorOf(second).code, "rate_limited");
    assert.ok(Number(second.headers["retry-after"]) > 0);
  });
});

describe("the error format", () => {
  test("malformed JSON is invalid_input", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/experiences/search",
      headers: { ...bearer(key), "content-type": "application/json" },
      payload: '{"near": ',
    });
    assert.equal(response.statusCode, 400);
    const error = errorOf(response);
    assert.equal(error.code, "invalid_input");
    assert.equal(error.message, "The request body is not valid JSON.");
  });

  test("an unknown property and a wrong value are invalid_input with one detail each", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/experiences/search",
      headers: bearer(key),
      payload: { ...SEARCH, near: { lat: 200, lng: 19.2 }, colour: "blue" },
    });
    assert.equal(response.statusCode, 400);
    const error = errorOf(response);
    assert.equal(error.code, "invalid_input");
    const paths = error.details.map((detail) => detail.path).sort();
    assert.deepEqual(paths, ["colour", "near.lat"]);
    assert.equal(error.details.find((detail) => detail.path === "colour")?.message, "Unknown field.");
  });

  test("a wrong content type, an empty body and a body that is too large are invalid_input", async () => {
    const cases = [
      { headers: { "content-type": "text/plain" }, payload: "hello" },
      { headers: { "content-type": "application/json" }, payload: "" },
      { headers: { "content-type": "application/json" }, payload: JSON.stringify({ ...SEARCH, query: "x".repeat(70_000) }) },
    ];
    for (const one of cases) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/experiences/search",
        headers: { ...bearer(key), ...one.headers },
        payload: one.payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorOf(response).code, "invalid_input");
      assert.doesNotMatch(response.body, /FST_|fastify/i);
    }
  });

  test("an unknown query parameter is invalid_input", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/health?verbose=1", headers: bearer(key) });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(errorOf(response).details, [{ path: "verbose", message: "Unknown field." }]);
  });

  describe("a system error", () => {
    let app: FastifyInstance;

    before(async () => {
      const url = process.env.TEST_DATABASE_URL ?? "";
      const settings = testSettings(url);
      ({ app } = await buildApp({ settings, db: harness.db, logger: createLogger(settings.api) }));
      app.get("/boom", { config: { action: "openapi.read" } }, () => {
        throw new Error('relation "users_secret" does not exist at postgres://magic@db');
      });
      await app.ready();
    });

    after(() => app.close());

    test("is internal_error with a general message, and nothing of the error leaks", async () => {
      const response = await app.inject({ method: "GET", url: "/boom", headers: bearer(key) });
      assert.equal(response.statusCode, 500);
      const error = errorOf(response);
      assert.equal(error.code, "internal_error");
      assert.doesNotMatch(response.body, /users_secret|postgres|relation|stack/);
    });
  });

  test("a route registered without an action stops the server starting", async () => {
    const url = process.env.TEST_DATABASE_URL ?? "";
    const settings = testSettings(url);
    const { app } = await buildApp({ settings, db: harness.db, logger: createLogger(settings.api) });
    assert.throws(() => app.get("/forgotten", () => "hello"), /has no config\.action/);
    await app.close();
  });
});

describe("while the database is down", () => {
  // The same app on a database that refuses every connection.
  const down = createDb("postgres://nobody@127.0.0.1:1/none", { max: 1 });
  let app: FastifyInstance;

  before(async () => {
    const settings = testSettings(process.env.TEST_DATABASE_URL ?? "");
    ({ app } = await buildApp({ settings, db: down.db, logger: createLogger(settings.api) }));
    await app.ready();
  });

  after(async () => {
    await app.close();
    await down.close();
  });

  function assertUnavailable(response: LightMyRequestResponse, what: string): void {
    assert.equal(response.statusCode, 503, what);
    assert.equal(errorOf(response).code, "unavailable", what);
    assert.ok(Number(response.headers["retry-after"]) > 0, what);
    assert.equal(response.headers["www-authenticate"], undefined, what);
    assert.doesNotMatch(response.body, /ECONNREFUSED|postgres|127\.0\.0\.1|query/i, what);
  }

  test("the health check answers 503 with Retry-After", async () => {
    assertUnavailable(await app.inject({ method: "GET", url: "/health" }), "GET /health");
  });

  test("a caller with a good key is answered 503, never 401, over REST and MCP", async () => {
    // The key is real: it was issued on the working database, which this app cannot reach.
    for (const route of [
      { method: "POST", url: "/v1/experiences/search", payload: SEARCH },
      { method: "GET", url: "/openapi.json" },
      { method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
    ] as const) {
      const response = await app.inject({ ...route, headers: { ...MCP_HEADERS, ...bearer(key) } });
      assertUnavailable(response, `${route.method} ${route.url}`);
    }
  });

  test("a caller without a key is still answered 401, as the check needs no database", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(response.statusCode, 401);
  });
});

describe("request IDs and headers", () => {
  test("an incoming plain x-request-id is used, and anything else is replaced", async () => {
    const kept = await harness.app.inject({ method: "GET", url: "/health", headers: { ...bearer(key), "x-request-id": "trip-42" } });
    assert.equal(kept.headers["x-request-id"], "trip-42");

    const replaced = await harness.app.inject({
      method: "GET",
      url: "/health",
      headers: { ...bearer(key), "x-request-id": "bad id\nwith a new line" },
    });
    assert.match(String(replaced.headers["x-request-id"]), /^[0-9a-f-]{36}$/);

    const generated = await harness.app.inject({ method: "GET", url: "/health", headers: bearer(key) });
    assert.match(String(generated.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  test("answers are not cached and do not name the server's software", async () => {
    for (const headers of [{}, bearer(key)]) {
      const response = await harness.app.inject({ method: "GET", url: "/health", headers });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-powered-by"], undefined);
      assert.equal(response.headers.server, undefined);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
    }
  });
});

describe("the OpenAPI document", () => {
  test("lists every route with its schemas, error answers and the API key security", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/openapi.json", headers: bearer(key) });
    assert.equal(response.statusCode, 200);
    const document = response.json<{
      openapi: string;
      security: Record<string, string[]>[];
      components: { securitySchemes: Record<string, { type: string; scheme?: string }> };
      paths: Record<
        string,
        Record<string, { operationId?: string; security?: unknown[]; responses: Record<string, unknown>; requestBody?: unknown }>
      >;
    }>();

    assert.match(document.openapi, /^3\.1/);
    assert.deepEqual(document.components.securitySchemes.bearer, {
      type: "http",
      scheme: "bearer",
      description: "The API key, as: Authorization: Bearer <key>.",
    });
    assert.deepEqual(document.security, [{ bearer: [] }, { apiKeyHeader: [] }]);

    const expected = {
      "/health": ["get"],
      "/openapi.json": ["get"],
      "/mcp": ["post", "get", "delete"],
      "/v1/experiences/search": ["post"],
      "/v1/experiences/changes": ["post"],
      "/v1/tenants": ["post", "get"],
      "/v1/tenants/{slug}": ["get", "patch"],
      "/v1/tenants/{slug}/users": ["post"],
      "/v1/users/{userId}/credentials": ["post", "get"],
      "/v1/users/{userId}/credentials/{credentialId}": ["delete"],
    };
    assert.deepEqual(Object.keys(document.paths).sort(), Object.keys(expected).sort());
    for (const [path, methods] of Object.entries(expected)) {
      for (const method of methods) {
        const operation = document.paths[path]?.[method];
        assert.ok(operation, `${method} ${path} is missing`);
        assert.ok(operation.operationId, `${method} ${path} has no operationId`);
        // The health check is public, so it never answers 401 or 403.
        for (const status of path === "/health" ? ["429", "500", "503"] : ["401", "403", "429", "500", "503"]) {
          assert.ok(operation.responses[status], `${method} ${path} does not document ${status}`);
        }
      }
    }
    const health = document.paths["/health"]?.get;
    assert.deepEqual(health?.security, []);
    assert.equal(health.responses["401"], undefined);
    assert.equal(health.responses["403"], undefined);
    assert.ok(document.paths["/v1/experiences/search"]?.post?.requestBody);
    assert.ok(document.paths["/v1/experiences/search"].post.responses["200"]);
    for (const [path, method] of [
      ["/v1/tenants/{slug}", "get"],
      ["/v1/tenants/{slug}", "patch"],
      ["/v1/tenants/{slug}/users", "post"],
      ["/v1/users/{userId}/credentials", "post"],
      ["/v1/users/{userId}/credentials", "get"],
      ["/v1/users/{userId}/credentials/{credentialId}", "delete"],
    ] as const) {
      assert.ok(document.paths[path]?.[method]?.responses["404"], `${method} ${path} does not document 404`);
    }
    assert.ok(document.paths["/v1/tenants"]?.post?.responses["201"]);
    assert.ok(document.paths["/v1/tenants"].post.requestBody);
  });
});

describe("MCP", () => {
  test("initialize, then tools/list, over the endpoint with a valid key", async () => {
    const initialize = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    assert.equal(initialize.statusCode, 200);
    const initialized = initialize.json<{ result: { serverInfo: { name: string }; capabilities: { tools?: unknown } } }>();
    assert.equal(initialized.result.serverInfo.name, "magic-events");
    assert.ok(initialized.result.capabilities.tools);

    const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.statusCode, 200);
    const tools = list.json<{
      result: { tools: { name: string; inputSchema: unknown; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }[] };
    }>().result.tools;
    const search = tools.find((tool) => tool.name === "search_experiences");
    assert.ok(search);
    assert.ok(search.inputSchema);
    assert.ok(search.outputSchema);
    assert.equal(search.annotations?.readOnlyHint, true);
  });

  test("a tool call returns structured content and the same JSON as text", async () => {
    const response = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_experiences", arguments: SEARCH },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json<{
      result: { structuredContent: { items: unknown[]; total: number }; content: { type: string; text: string }[] };
    }>().result;
    assert.equal(result.structuredContent.total, 0);
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), result.structuredContent);
  });

  test("a tool call with arguments that do not fit is a tool error", async () => {
    const response = await mcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_experiences", arguments: { ...SEARCH, near: { lat: 500, lng: 0 } } },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<{ result: { isError?: boolean } }>().result.isError, true);
  });

  test("without a key the endpoint answers 401", async () => {
    const response = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["www-authenticate"], 'Bearer realm="magic-events"');
  });

  test("GET and DELETE answer 405 in JSON-RPC form, after authentication", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await harness.app.inject({ method, url: "/mcp", headers: bearer(key) });
      assert.equal(response.statusCode, 405);
      assert.equal(response.headers.allow, "POST");
      assert.deepEqual(response.json(), { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
  });

  test("a host or origin that is not allowed is refused", async () => {
    const host = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...bearer(key), host: "evil.example.com" });
    assert.equal(host.statusCode, 403);
    const origin = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...bearer(key), origin: "https://evil.example.com" });
    assert.equal(origin.statusCode, 403);
  });
});
