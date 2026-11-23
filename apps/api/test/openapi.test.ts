import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDb } from "@magic-events/db";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { testSettings } from "@magic-events/core/testing/harness.ts";
import { buildApp } from "../src/app.ts";
import { openApiDocument, openApiText } from "../src/openapi.ts";
import { registeredRoutes } from "./helpers/routes.ts";

// The document the openapi script writes, built with no database: the app is pointed at a port nothing listens on.
// What the document says of each route's schemas and answers is in platform.test.ts; this checks that the script's
// document covers every route the server registers, and that each operation is complete enough to call.

const NO_DATABASE = "postgres://nobody@127.0.0.1:1/none";

interface Operation {
  operationId?: string;
  summary?: string;
  security?: Record<string, string[]>[];
  responses?: Record<string, unknown>;
}

interface Document {
  openapi: string;
  security?: Record<string, string[]>[];
  components?: { securitySchemes?: Record<string, { type: string; description?: string }> };
  paths: Record<string, Record<string, Operation>>;
}

// Every method and path the server answers, as "post /v1/experiences/search", from Fastify's route tree. HEAD is
// added by Fastify for every GET, and the catch-all OPTIONS route is @fastify/cors's: neither is an operation of the API.
async function registeredOperations(): Promise<string[]> {
  const settings = testSettings(NO_DATABASE);
  const database = createDb(NO_DATABASE, { max: 1 });
  const { app } = await buildApp({ settings, db: database.db, logger: createLogger(settings.api) });
  try {
    await app.ready();
    return registeredRoutes(app)
      .filter((route) => route.method !== "HEAD" && route.url !== "*")
      .map((route) => `${route.method.toLowerCase()} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
      .sort();
  } finally {
    await app.close();
    await database.close();
  }
}

describe("the openapi script's document", () => {
  test("is OpenAPI 3.1 and lists every route the server registers, each with an operationId, a summary and an answer", async () => {
    const document = JSON.parse(openApiText(await openApiDocument(testSettings(NO_DATABASE)))) as Document;
    assert.match(document.openapi, /^3\.1/);

    const operations = Object.entries(document.paths)
      .flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`))
      .sort();
    const routes = await registeredOperations();
    assert.deepEqual(operations, routes);
    for (const route of routes) {
      const path = route.split(" ")[1] ?? "";
      assert.ok(path.startsWith("/v1/") || ["/health", "/openapi.json", "/mcp"].includes(path), `${route} is unexpected`);
    }

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const name = `${method} ${path}`;
        assert.ok(operation.operationId, `${name} has no operationId`);
        assert.ok(operation.summary, `${name} has no summary`);
        assert.ok(Object.keys(operation.responses ?? {}).length > 0, `${name} documents no answer`);
      }
    }
  });

  test("states on every operation how it is authenticated: an API key with its 401 and 403, or for /health no key", async () => {
    const document = JSON.parse(openApiText(await openApiDocument(testSettings(NO_DATABASE)))) as Document;
    const schemes = document.components?.securitySchemes ?? {};
    assert.ok(Object.keys(schemes).length > 0, "the document defines no security scheme");
    for (const [name, scheme] of Object.entries(schemes)) {
      assert.match(scheme.description ?? "", /mev_/, `the ${name} scheme does not say what a key looks like`);
      assert.match(scheme.description ?? "", /pnpm cli:admin key issue/, `the ${name} scheme does not say where a key comes from`);
    }

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const name = `${method} ${path}`;
        // Its own, so a reader of one operation sees it, rather than the document's default.
        assert.ok(operation.security, `${name} does not state its security`);
        if (path === "/health") {
          assert.deepEqual(operation.security, [], `${name} asks for a key`);
          assert.equal(operation.responses?.["401"], undefined, `${name} documents a 401`);
          continue;
        }
        assert.ok(operation.security.length > 0, `${name} needs no key`);
        for (const requirement of operation.security) {
          assert.ok(Object.keys(requirement).length > 0, `${name} lets a caller in with no scheme`);
          for (const scheme of Object.keys(requirement)) assert.ok(schemes[scheme], `${name} names ${scheme}, which is not defined`);
        }
        assert.ok(operation.responses?.["401"], `${name} does not document 401`);
        assert.ok(operation.responses["403"], `${name} does not document 403`);
      }
    }
  });
});
