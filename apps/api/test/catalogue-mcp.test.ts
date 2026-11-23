import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { insertExperienceFixture } from "@magic-events/core/testing/experience-fixture.ts";
import { input as listing } from "@magic-events/core/testing/catalogue-fake.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";

let harness: Harness;
let key: string;

const search = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-06-10", to: "2027-06-20", tags: ["whales"] };

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
  outputSchema?: { type: string; properties: Record<string, unknown> };
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: unknown;
}

// A change of the jazz evening saved below, on 13 March 2027, from a minute before it was saved.
const changes = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-03-01", to: "2027-03-31", since: "" };

let nextId = 1;

function mcp(method: string, params: object, headers: Record<string, string> = { authorization: `Bearer ${key}` }) {
  return harness.app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    payload: { jsonrpc: "2.0", id: nextId++, method, params },
  });
}

async function result<T>(method: string, params: object): Promise<T> {
  const response = await mcp(method, params);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ result?: T; error?: unknown }>();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  assert.ok(body.result !== undefined);
  return body.result;
}

before(async () => {
  harness = await createHarness();
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
});

after(async () => {
  await harness.close();
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
    assert.match(tool.description, /sessions/);
    assert.match(tool.description, /query/);
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
    assert.deepEqual(answer.error.details, [{ path: "colour", message: "Unknown field." }]);
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
