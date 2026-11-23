import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { logContext } from "@magic-events/core/shared/log-context.ts";
import { insertExperienceFixture } from "@magic-events/core/testing/experience-fixture.ts";
import { input as listing } from "@magic-events/core/testing/catalogue-fake.ts";
import { testOverrides, testSettings } from "@magic-events/core/testing/harness.ts";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";

// The MCP server as an agent meets it: the two client tools, what they say about themselves, and their answers, which
// equal REST's. Most of it is driven through the SDK's own client, which checks every structured answer against the
// tool's output schema, as a client in the field does.

let harness: Harness;
let key: string;
let adminKey: string;

const search = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-06-10", to: "2027-06-20", tags: ["whales"] };

interface Tool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
  outputSchema?: { type: string; properties: Record<string, unknown> };
  annotations?: Record<string, unknown>;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: unknown;
}

// A change of the jazz evening saved below, on 13 March 2027, from a minute before it was saved.
const changes = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-03-01", to: "2027-03-31", since: "" };

const CLIENT_TOOLS = ["get_experience_changes", "search_experiences"];

let nextId = 1;

function mcp(method: string, params: object, headers: Record<string, string> = { authorization: `Bearer ${key}` }) {
  return harness.app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    payload: { jsonrpc: "2.0", id: nextId++, method, params },
  });
}

async function result<T>(method: string, params: object, credential = key): Promise<T> {
  const response = await mcp(method, params, { authorization: `Bearer ${credential}` });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ result?: T; error?: unknown }>();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  assert.ok(body.result !== undefined);
  return body.result;
}

// The SDK's client over app.inject in place of the network, so it speaks to the server exactly as over HTTP.
async function connect(app: FastifyInstance, credential: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${credential}` } },
    fetch: async (url, init) => {
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
        url: new URL(url).pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { payload: init.body } : {}),
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
      return new Response(response.body === "" ? null : response.body, { status: response.statusCode, headers });
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// Every property, at every depth, that has no description of its own, by its path.
function undescribed(schema: unknown, path = ""): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const missing: string[] = [];
  const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, property] of Object.entries(properties)) {
    const at = path ? `${path}.${name}` : name;
    if (typeof property.description !== "string" || property.description.length === 0) missing.push(at);
    missing.push(...undescribed(property, at));
  }
  for (const member of [...((node.anyOf ?? []) as unknown[]), ...((node.oneOf ?? []) as unknown[])]) {
    missing.push(...undescribed(member, path));
  }
  if (node.items !== undefined) missing.push(...undescribed(node.items, `${path}[]`));
  if (typeof node.additionalProperties === "object") missing.push(...undescribed(node.additionalProperties, `${path}.*`));
  return missing;
}

before(async () => {
  harness = await createHarness();
  await harness.services.dataProcessing.saveTag({ slug: "whales", name: "Whales", description: "Whales." });
  const hermanus = await harness.services.catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
  for (const [title, startDate] of [
    ["Hermanus Whale Festival", "2027-06-12"],
    ["Whale Watching Cruise", "2027-06-15"],
  ] as const) {
    await insertExperienceFixture(harness.db, {
      locationId: hermanus.id,
      title,
      booking: "open",
      venue: { lat: -34.421, lng: 19.244 },
      sessions: [{ startDate }],
      attributes: { category: ["nature_and_wildlife"] },
      tags: ["whales"],
    });
  }
  changes.since = new Date(Date.now() - 60_000).toISOString();
  await harness.services.catalogue.saveExperience(listing({ locationId: hermanus.id }));
  ({ key } = await harness.createCaller({ kind: "agent" }));
  ({ key: adminKey } = await harness.createCaller({ role: "system_admin" }));
});

after(async () => {
  await harness.close();
});

describe("MCP server", () => {
  test("initialize declares the tools alone, unchanging, with the server's name and instructions", async () => {
    const client = await connect(harness.app, key);
    try {
      assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });
      assert.equal(client.getServerVersion()?.name, "magic-events");
      const instructions = client.getInstructions() ?? "";
      for (const words of ["Hermanus", "search_experiences", "get_experience_changes", "query", "bookable", "requestId"]) {
        assert.match(instructions, new RegExp(words), `the instructions name ${words}`);
      }
      assert.doesNotMatch(instructions, /tenant|admin|onboard|credential/i);
    } finally {
      await client.close();
    }
  });

  test("tools/list holds exactly the client's two tools, for a client and for a system admin", async () => {
    for (const credential of [key, adminKey]) {
      const { tools } = await result<{ tools: Tool[] }>("tools/list", {}, credential);
      assert.deepEqual(tools.map((tool) => tool.name).sort(), CLIENT_TOOLS);
    }
  });

  test("both tools are read-only reads of content from the open web, with a title", async () => {
    const { tools } = await result<{ tools: Tool[] }>("tools/list", {});
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has a title`);
      assert.deepEqual(
        { ...tool.annotations, title: undefined },
        { title: undefined, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        tool.name,
      );
    }
  });

  test("every field of every input and output schema has a description", async () => {
    const { tools } = await result<{ tools: Tool[] }>("tools/list", {});
    for (const tool of tools) {
      assert.deepEqual(undescribed(tool.inputSchema), [], `${tool.name} input`);
      assert.deepEqual(undescribed(tool.outputSchema), [], `${tool.name} output`);
    }
  });

  test("a removed onboarding tool is the protocol's unknown-tool error, for a system admin too", async () => {
    for (const name of ["list_tenants", "create_tenant", "issue_credential"]) {
      const response = await mcp("tools/call", { name, arguments: {} }, { authorization: `Bearer ${adminKey}` });
      assert.equal(response.statusCode, 200);
      const body = response.json<{ error?: { code: number; message: string } }>();
      assert.equal(body.error?.code, -32602, name);
      assert.match(body.error.message, new RegExp(name));
    }
  });

  test("the SDK's client calls both tools, and their structured answers pass its output schema check", async () => {
    const client = await connect(harness.app, key);
    try {
      await client.listTools();
      const found = (await client.callTool({ name: "search_experiences", arguments: search })) as ToolResult;
      assert.notEqual(found.isError, true, JSON.stringify(found.content));
      assert.equal((found.structuredContent as { total: number }).total, 2);
      const changed = (await client.callTool({ name: "get_experience_changes", arguments: changes })) as ToolResult;
      assert.notEqual(changed.isError, true, JSON.stringify(changed.content));
      assert.equal((changed.structuredContent as { total: number }).total, 1);
      await assert.rejects(client.callTool({ name: "no_such_tool", arguments: {} }), (error: unknown) => {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, -32602);
        return true;
      });
    } finally {
      await client.close();
    }
  });

  test("logs who called which tool with which arguments, and never the key", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
        done();
      },
    });
    const settings = testSettings(process.env.TEST_DATABASE_URL ?? "");
    const logger = pino({ level: "info", mixin: () => ({ ...logContext.getStore() }) }, stream);
    const { app } = await buildApp({ settings, db: harness.db, logger, overrides: testOverrides({}) });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_experiences", arguments: search } },
      });
      assert.equal(response.statusCode, 200);
    } finally {
      await app.close();
    }
    const called = lines.find((line) => line.msg === "Tool called");
    assert.ok(called, "the call is logged");
    assert.equal(called.tool, "search_experiences");
    assert.deepEqual(called.arguments, search);
    assert.equal(called.callerKind, "agent");
    assert.ok(typeof called.requestId === "string");
    assert.equal(JSON.stringify(lines).includes(key), false, "no line holds the key");
  });
});

describe("MCP search_experiences", () => {
  test("tools/list shows the tool with its input and output schemas", async () => {
    const { tools } = await result<{ tools: Tool[] }>("tools/list", {});
    const tool = tools.find((one) => one.name === "search_experiences");
    assert.ok(tool, "search_experiences is listed");
    assert.equal(tool.inputSchema.type, "object");
    for (const field of ["location", "near", "radiusKm", "from", "to", "status", "bookable", "attributes", "tags", "query"]) {
      assert.ok(field in tool.inputSchema.properties, `input has ${field}`);
    }
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), ["from", "to"]);
    assert.ok(tool.outputSchema, "the tool has an output schema");
    for (const field of ["items", "total", "limit", "offset"]) {
      assert.ok(field in tool.outputSchema.properties, `output has ${field}`);
    }
    assert.match(tool.description, /"location": "hermanus", "from": "2027-06-20", "to": "2027-06-30"/);
    assert.match(tool.description, /sessions/);
    assert.match(tool.description, /query/);
    assert.match(tool.description, /get_experience_changes/);
  });

  test("tools/call answers with the same content as REST", async () => {
    const called = await result<ToolResult>("tools/call", { name: "search_experiences", arguments: search });
    assert.notEqual(called.isError, true, JSON.stringify(called.content));

    const rest = await harness.app.inject({
      method: "POST",
      url: "/v1/experiences/search",
      headers: { authorization: `Bearer ${key}` },
      payload: search,
    });
    assert.equal(rest.statusCode, 200);
    assert.deepEqual(called.structuredContent, rest.json());
    assert.deepEqual(JSON.parse(called.content[0]?.text ?? ""), rest.json());

    const answer = rest.json<{ total: number }>();
    assert.equal(answer.total, 2);
  });

  test("invalid arguments come back as a tool error with a readable message", async () => {
    const called = await result<ToolResult>("tools/call", {
      name: "search_experiences",
      arguments: { ...search, near: { lat: 123, lng: 19.2345 } },
    });
    assert.equal(called.isError, true);
    // The REST API's error format, with the field named, so an agent can correct its call.
    const answer = JSON.parse(called.content[0]?.text ?? "{}") as {
      error: { code: string; message: string; details: { path: string; message: string }[]; requestId: string };
    };
    assert.equal(answer.error.code, "invalid_input");
    assert.deepEqual(
      answer.error.details.map((detail) => detail.path),
      ["near.lat"],
    );
    assert.ok(answer.error.requestId.length > 0);
  });

  test("an unknown argument is invalid_input that names it", async () => {
    const called = await result<ToolResult>("tools/call", {
      name: "search_experiences",
      arguments: { ...search, colour: "blue" },
    });
    assert.equal(called.isError, true);
    const answer = JSON.parse(called.content[0]?.text ?? "{}") as { error: { code: string; details: unknown[] } };
    assert.equal(answer.error.code, "invalid_input");
    assert.deepEqual(answer.error.details, [{ path: "colour", message: "colour is not a field this takes. Check its spelling." }]);
  });

  test("a tool that does not exist is a JSON-RPC invalid params error", async () => {
    const response = await mcp("tools/call", { name: "no_such_tool", arguments: {} });
    assert.equal(response.statusCode, 200);
    const body = response.json<{ error?: { code: number; message: string } }>();
    assert.equal(body.error?.code, -32602);
    assert.match(body.error.message, /no_such_tool/);
  });

  test("a refused search comes back as a tool error that names the limit", async () => {
    const called = await result<ToolResult>("tools/call", {
      name: "search_experiences",
      arguments: { ...search, radiusKm: 500 },
    });
    assert.equal(called.isError, true);
    const text = called.content.map((part) => part.text).join(" ");
    assert.match(text, /invalid_input/);
    assert.match(text, /200 km/);
  });

  test("returns 401 without a key", async () => {
    const response = await mcp("tools/list", {}, {});
    assert.equal(response.statusCode, 401);
  });
});

describe("MCP get_experience_changes", () => {
  test("tools/list shows the tool, written for an agent, without a query text", async () => {
    const { tools } = await result<{ tools: Tool[] }>("tools/list", {});
    const tool = tools.find((one) => one.name === "get_experience_changes");
    assert.ok(tool, "get_experience_changes is listed");
    assert.ok("since" in tool.inputSchema.properties);
    assert.equal("query" in tool.inputSchema.properties, false);
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), ["from", "since", "to"]);
    for (const field of ["items", "total", "limit", "offset"]) {
      assert.ok(tool.outputSchema && field in tool.outputSchema.properties, `output has ${field}`);
    }
    for (const kind of ["new", "confirmed", "rescheduled", "postponed", "cancelled", "removed", "changed"]) {
      assert.match(tool.description, new RegExp(`${kind}:`));
    }
    assert.match(tool.description, /search_experiences no longer returns them/);
  });

  test("tools/call answers with the same content as REST", async () => {
    const called = await result<ToolResult>("tools/call", { name: "get_experience_changes", arguments: changes });
    assert.notEqual(called.isError, true, JSON.stringify(called.content));

    const rest = await harness.app.inject({
      method: "POST",
      url: "/v1/experiences/changes",
      headers: { authorization: `Bearer ${key}` },
      payload: changes,
    });
    assert.equal(rest.statusCode, 200);
    assert.deepEqual(called.structuredContent, rest.json());
    assert.equal(rest.json<{ total: number }>().total, 1);
  });

  test("a time in the future comes back as a tool error that names since", async () => {
    const called = await result<ToolResult>("tools/call", {
      name: "get_experience_changes",
      arguments: { ...changes, since: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(called.isError, true);
    const text = called.content.map((part) => part.text).join(" ");
    assert.match(text, /invalid_input/);
    assert.match(text, /since/);
  });
});
