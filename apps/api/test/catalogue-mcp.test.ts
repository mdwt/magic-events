import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { insertExperienceFixture } from "../src/seed/experience-fixture.ts";
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
    for (const field of ["near", "radiusKm", "from", "to", "status", "bookable", "attributes", "tags", "query"]) {
      assert.ok(field in tool.inputSchema.properties, `input has ${field}`);
    }
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), ["from", "near", "to"]);
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
    const text = called.content.map((part) => part.text).join(" ");
    assert.match(text, /near/);
    assert.match(text, /lat/);
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
