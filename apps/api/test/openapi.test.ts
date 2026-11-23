import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDb } from "@magic-events/db";
import { createLogger } from "@magic-events/core/adapters/logging/pino.ts";
import { testSettings } from "@magic-events/core/testing/harness.ts";
import { buildApp } from "../src/app.ts";
import { openApiDocument, openApiText } from "../src/openapi.ts";

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
  paths: Record<string, Record<string, Operation>>;
}

// Every method and path the server answers, as "post /v1/experiences/search", read from Fastify's route tree. HEAD is
// added by Fastify for every GET, and the catch-all OPTIONS route is @fastify/cors's: neither is an operation of the API.
async function registeredRoutes(): Promise<string[]> {
  const settings = testSettings(NO_DATABASE);
  const database = createDb(NO_DATABASE, { max: 1 });
  const { app } = await buildApp({ settings, db: database.db, logger: createLogger(settings.api) });
  try {
    await app.ready();
    const routes: string[] = [];
    const prefixes: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const match = /^((?:│ {3}| {4})*)[├└]── (\S+) \(([^)]+)\)$/.exec(line);
      if (!match) continue;
      const [, indent = "", segment = "", methods = ""] = match;
      const depth = indent.length / 4;
      prefixes.length = depth;
      const path = `${prefixes.join("")}${segment}`;
      prefixes.push(segment);
      if (segment === "*") continue;
      for (const method of methods.split(", ")) {
        if (method !== "HEAD") routes.push(`${method.toLowerCase()} ${path.replace(/:(\w+)/g, "{$1}")}`);
      }
    }
    return routes.sort();
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
    const routes = await registeredRoutes();
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
        // An operation's own security replaces the document's. Only the health check is public.
        const security = operation.security ?? document.security ?? [];
        if (path === "/health") assert.deepEqual(security, [], `${name} asks for a key`);
        else assert.ok(security.some((scheme) => "bearer" in scheme), `${name} does not declare the bearer scheme`);
      }
    }
  });
});
