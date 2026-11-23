import { isDeepStrictEqual } from "node:util";
import { calls, errorOf, send, type Call } from "../harness/api.ts";
import { admin } from "../harness/cli.ts";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import { databaseUrl } from "../harness/db.ts";
import { WINTER, type Body } from "../harness/feed.ts";
import { linesOf, secretsIn } from "../harness/logs.ts";
import { rpc, toolResultOf } from "../harness/mcp.ts";
import { committedDocument, operations } from "../harness/openapi.ts";
import { DatabaseProxy } from "../harness/proxy.ts";
import { scenario } from "../harness/scenario.ts";
import { freePort, LEVEL, until, type ApiServer } from "../harness/server.ts";
import { clientFor, startServer } from "../harness/setup.ts";
import { client, mainServer, recall, remember, state } from "../harness/state.ts";

// Trust and safety of the interface: E2E-37 to E2E-41.

// Each operation of the OpenAPI document once, with a valid request from the Agency Planner.
export async function callEveryOperation(server: ApiServer): Promise<Call[]> {
  const made: Call[] = [];
  for (const operation of operations) {
    const path = operation.path.replace(/\{[^}]+\}/g, "x");
    let body: unknown;
    if (operation.path === "/mcp" && operation.method === "POST") body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    else if (operation.operationId === "getExperienceChanges") body = { ...WINTER, since: "2026-11-01T00:00:00Z" };
    else if (operation.method === "POST" || operation.method === "PATCH") body = WINTER;
    const who = operation.path === "/mcp" ? client("agency agent") : client("agency person");
    const headers: Record<string, string> = operation.path === "/mcp" ? { accept: "application/json, text/event-stream" } : {};
    made.push(await send(server, { method: operation.method, path, client: who, headers, ...(body === undefined ? {} : { body }) }));
  }
  return made;
}

function checkUnauthenticated(c: Checks, call: Call, what: string): void {
  const error = errorOf(call.json);
  c.ok(call.status === 401 && error?.code === "unauthenticated", `${what} is ${call.status} ${error?.code ?? ""}`);
  c.ok(call.headers.get("www-authenticate") !== null, `${what} has WWW-Authenticate`);
}

// The error format: code, message, details with path and message, and the request ID of the header.
function checkErrorFormat(c: Checks, call: Call, what: string): void {
  const error = errorOf(call.json);
  if (!c.ok(error !== undefined, `${what} is in the one error format: ${call.text.slice(0, 200)}`) || error === undefined) return;
  c.ok(typeof error.code === "string" && typeof error.message === "string" && Array.isArray(error.details), `${what} has code, message and details`);
  c.ok(error.requestId === call.requestId, `${what}'s requestId is the x-request-id`);
}

// A plain sentence, in our own words.
const LIBRARY_WORDING = /Invalid input|expected|Too big|Too small|Unknown field|schema|received|Unrecognized/i;

function checkPlain(c: Checks, message: string, what: string): void {
  c.ok(!LIBRARY_WORDING.test(message), `${what}: "${message}" holds a library's wording`);
  c.ok(message.trim().length > 10 && /[.]$/.test(message.trim()), `${what}: "${message}" is not a sentence`);
}

const WRONG: [string, Body | string, string, RegExp][] = [
  ["from 2027-13-01", { ...WINTER, from: "2027-13-01" }, "from", /\d{4}-\d{2}-\d{2}/],
  ["to before from", { ...WINTER, to: "2027-06-01" }, "to", /from|before|after/i],
  ["an extra field", { ...WINTER, date: "2027-06-20" }, "date", /field|take/i],
  ["attribute colour", { ...WINTER, attributes: { colour: "red" } }, "attributes.colour", /category/],
  ["category opera", { ...WINTER, attributes: { category: ["opera"] } }, "attributes.category", /visual_arts/],
  ["minimum age ten", { ...WINTER, attributes: { minimum_age: "ten" } }, "attributes.minimum_age", /number|min|max|range|list/i],
  ["minimum age {}", { ...WINTER, attributes: { minimum_age: {} } }, "attributes.minimum_age", /min|max/i],
  ["limit 500", { ...WINTER, limit: 500 }, "limit", /100/],
  ["a body that is not JSON", '{"location": "hermanus", ', "", /not valid JSON/i],
];

// What no answer may hold: a stack trace, SQL, a table or column, a file path, a library or a provider.
const INSIDES =
  /\bat [\w.<>]+ \(|\.ts:\d+|node_modules|\/Users\/|\bselect\b.+\bfrom\b|\binsert into\b|violates|constraint|experience_session|raw_listing|apikey|drizzle|postgres|pg-boss|ECONNREFUSED|ETIMEDOUT|FST_ERR|ZodError|Bedrock|Anthropic|better-auth|fastify/i;

export function registerSafety(): void {
  scenario("E2E-37", "No call without a valid key", async ({ c }) => {
    const main = mainServer();
    const search = { path: "/v1/experiences/search", body: WINTER };
    checkUnauthenticated(c, await send(main, search), "search with no key");
    checkUnauthenticated(c, await send(main, { ...search, authorization: "Bearer nonsense" }), "search with Bearer nonsense");
    checkUnauthenticated(c, await send(main, { ...search, authorization: "Token abc" }), "search with a malformed header");
    checkUnauthenticated(c, await send(main, { ...search, authorization: "Bearer" }), "search with Bearer and no key");
    checkUnauthenticated(c, await rpc(main, undefined, "tools/list", {}), "POST /mcp with no key");
    checkUnauthenticated(c, await send(main, { path: "/v1/nothing-here" }), "an unknown address with no key");
    const unknown = await send(main, { path: "/v1/nothing-here", client: client("agency person") });
    c.ok(unknown.status === 404 && errorOf(unknown.json)?.code === "not_found", `an unknown address with a key is ${unknown.status}`);
    const health = await send(main, { path: "/health" });
    c.ok(health.status === 200 && isDeepStrictEqual(health.json, { status: "ok" }), `/health with no key: ${health.status} ${health.text}`);
    checkUnauthenticated(c, await send(main, { path: "/openapi.json" }), "/openapi.json with no key");
    const document = await send(main, { path: "/openapi.json", client: client("agency person") });
    c.equal(document.status, 200, "/openapi.json with a key");
    c.ok(isDeepStrictEqual(document.json, committedDocument), "the served /openapi.json equals the committed apps/api/openapi.json");
    const header = await send(main, { ...search, client: client("agency person"), apiKeyHeader: true });
    c.equal(header.status, 200, "the key in x-api-key");
  });

  scenario("E2E-38", "Wrong input gets a message that names the field", async ({ c }) => {
    const main = mainServer();
    for (const [what, body, path, says] of WRONG) {
      const call =
        typeof body === "string"
          ? await send(main, { path: "/v1/experiences/search", client: client("agency person"), rawBody: body })
          : await send(main, { path: "/v1/experiences/search", client: client("agency person"), body });
      const error = errorOf(call.json);
      c.ok(call.status === 400 && error?.code === "invalid_input", `${what}: ${call.status} ${error?.code ?? ""}`);
      checkErrorFormat(c, call, what);
      if (error === undefined) continue;
      if (path === "") {
        c.ok(says.test(error.message), `${what}: the message says so: "${error.message}"`);
        checkPlain(c, error.message, what);
        continue;
      }
      const detail = error.details.find((one) => one.path === path);
      if (!c.ok(detail !== undefined, `${what}: a detail names ${path}: ${show(error.details)}`) || detail === undefined) continue;
      c.ok(says.test(detail.message), `${what}: the detail on ${path} says what to give: "${detail.message}"`);
      checkPlain(c, detail.message, `${what}, detail`);
      checkPlain(c, error.message, `${what}, message`);

      const tool = await rpc(main, client("agency agent"), "tools/call", { name: "search_experiences", arguments: body });
      const result = toolResultOf(tool);
      c.ok(result?.isError === true, `${what} over MCP is a tool error`);
      let named: boolean;
      try {
        const parsed = JSON.parse(result?.text ?? "") as { error?: { details?: { path: string }[] } };
        named = parsed.error?.details?.some((one) => one.path === path) === true;
      } catch {
        named = false;
      }
      c.ok(named, `${what} over MCP names ${path}: ${(result?.text ?? "").slice(0, 200)}`);
    }
  });

  scenario("E2E-39", "No system detail reaches a caller", async ({ c, logs }) => {
    const port = await freePort();
    const proxy = new DatabaseProxy(port, { host: "127.0.0.1", port: 5434 });
    await proxy.open();
    let server: ApiServer | undefined;
    try {
      const url = databaseUrl(state.dbName).replace("localhost:5434", `127.0.0.1:${port}`);
      server = await startServer("database-down", { DATABASE_URL: url });
      const down: Call[] = [];
      await proxy.close();
      const asked = async (on: ApiServer) => [
        await send(on, { path: "/v1/experiences/search", client: client("agency person"), body: WINTER }),
        await rpc(on, client("agency agent"), "tools/call", { name: "search_experiences", arguments: WINTER }),
        await send(on, { path: "/health" }),
        await send(on, { path: "/openapi.json", client: client("agency person") }),
        await send(on, { path: "/v1/experiences/changes", client: client("agency person"), body: { ...WINTER, since: "2026-11-01T00:00:00Z" } }),
      ];
      for (const call of await asked(server)) {
        down.push(call);
        const error = errorOf(call.json);
        c.ok(call.status === 503 && error?.code === "unavailable", `while the database is down ${call.method} ${call.path} is ${call.status} ${error?.code ?? ""}`);
        c.ok(call.headers.get("retry-after") !== null, `${call.path} while down has Retry-After`);
        checkErrorFormat(c, call, `${call.path} while down`);
      }
      remember("E2E-39 failed", down[0]);
      // Every operation answers 503 while the database is down: the key cannot be checked, and /health says so.
      for (const call of await callEveryOperation(server)) {
        c.ok(call.status === 503, `while the database is down ${call.method} ${call.path} is ${call.status}`);
      }
      await proxy.open();
      const on = server;
      await until(
        "the server to reach its database again",
        async () => ((await send(on, { path: "/health" })).status === 200 ? true : undefined),
        30_000,
        500,
      );
      for (const call of await asked(server)) c.equal(call.status, 200, `once the database is back ${call.method} ${call.path}`);
      logs((lc) => {
        for (const call of down) {
          const lines = linesOf(call.server, call.requestId ?? "");
          const failure = lines.find((line) => (line.level ?? 0) >= LEVEL.error && line.err !== undefined);
          lc.ok(failure !== undefined, `the 503 of ${call.path} is logged at error with the error itself`);
        }
      });
    } finally {
      await server?.stop();
      await proxy.close();
    }
  });

  scenario("E2E-40", "Rate limits stop a runaway client", async ({ c, logs }) => {
    const limited = await startServer("rate-limited", { API_RATE_LIMIT_MAX: "5" });
    try {
      const sent: Call[] = [];
      for (let index = 0; index < 6; index += 1) sent.push(await send(limited, { path: "/health" }));
      const sixth = sent[5];
      c.ok(sixth?.status === 429 && errorOf(sixth.json)?.code === "rate_limited", `the sixth request from the address is ${String(sixth?.status)}`);
      c.ok(sixth?.headers.get("retry-after") !== null, "the 429 has Retry-After");
      // Every operation answers 429 once the address is over its limit.
      await callEveryOperation(limited);
    } finally {
      await limited.stop();
    }

    // A key's limit is set when it is issued, so the key is issued with a low one.
    const issued = await admin(["key", "issue", "--user", "planner@agency.example.com", "--name", "rate limit test", "--kind", "person"], {
      API_KEY_RATE_LIMIT_MAX: "5",
    });
    const key = /\b(mev_[A-Za-z0-9]+)\b/.exec(issued.stdout)?.[1];
    if (!c.ok(key !== undefined, `the low-limit key was issued: ${issued.output.slice(-300)}`) || key === undefined) return;
    const low = await clientFor("low limit", "planner@agency.example.com", "rate limit test", key);
    const searches: Call[] = [];
    for (let index = 0; index < 6; index += 1) {
      searches.push(await send(mainServer(), { path: "/v1/experiences/search", client: low, body: WINTER }));
    }
    const sixth = searches[5];
    c.ok(sixth?.status === 429 && errorOf(sixth.json)?.code === "rate_limited", `the sixth search with the key is ${String(sixth?.status)}`);
    c.ok(sixth?.headers.get("retry-after") !== null, "the key's 429 has Retry-After");
    c.equal((await send(mainServer(), { path: "/v1/experiences/search", client: client("agency person"), body: WINTER })).status, 200, "another key");
    const throttled = calls.filter((call) => call.server === mainServer() && call.status === 429 && call.client !== low);
    c.equal(throttled.map((call) => `${call.scenario} ${call.path}`), [], "requests limited with the default limits");
    logs((lc) => {
      const line = sixth?.requestId ? mainServer().find((one) => one.requestId === sixth.requestId && one.msg === "API key over its rate limit") : undefined;
      lc.ok(line?.level === LEVEL.warn, "the key over its limit is logged at warn");
    });
  });

  scenario("E2E-41", "Every request is traced to who made it", async ({ c }) => {
    const main = mainServer();
    const sources: [string, string | null | undefined][] = [
      ["E2E-01", calls.find((call) => call.scenario === "E2E-01")?.requestId],
      ["E2E-09", recall<string>("E2E-09 request")],
      ["E2E-36", calls.find((call) => call.scenario === "E2E-36" && call.status === 404)?.requestId],
      ["E2E-39", recall<Call>("E2E-39 failed")?.requestId],
    ];
    for (const [from, requestId] of sources) {
      if (!c.ok(typeof requestId === "string", `a request ID from ${from}`) || typeof requestId !== "string") continue;
      const call = calls.find((one) => one.requestId === requestId);
      const server = call?.server ?? main;
      const lines = linesOf(server, requestId);
      const closing = lines.find((line) => line.msg === "Request completed");
      c.ok(closing !== undefined && typeof closing.statusCode === "number" && typeof closing.durationMs === "number", `${from}: the closing line has the status and the time it took`);
      if (from !== "E2E-39") {
        for (const field of ["tenantId", "userId", "callerKind", "credentialId"]) {
          c.ok(closing !== undefined && field in closing, `${from}: the closing line carries ${field}`);
        }
      }
    }
    // Followed end to end: the inbound side, then the domain service, in order.
    const traced = calls.find((call) => call.scenario === "E2E-01");
    if (traced?.requestId) {
      const order = linesOf(main, traced.requestId).map((line) => String(line.msg));
      const expected = ["Request started", "Searching experiences", "Searched experiences", "Request completed"];
      c.equal(order.filter((msg) => expected.includes(msg)), expected, "E2E-01's lines, in order");
    }
    // An incoming request ID is used when it is a plain token, and replaced when it is not.
    const sane = await send(main, { path: "/health", headers: { "x-request-id": "e2e-trace-0001" } });
    c.equal(sane.requestId, "e2e-trace-0001", "a plain incoming x-request-id is kept");
    const injected = await send(main, { path: "/health", headers: { "x-request-id": "has spaces; and=signs" } });
    c.ok(injected.requestId !== null && /^[A-Za-z0-9._:-]+$/.test(injected.requestId), `an incoming x-request-id that is not a plain token is replaced: ${String(injected.requestId)}`);
    for (const server of state.servers) {
      const found = secretsIn(server.text(), [...state.keys]);
      c.equal(found, [], `keys in ${server.name}'s log`);
    }
  });

}

// After every other scenario: no answer of the whole run held a system detail.
export function registerSweep(): void {
  scenario("E2E-39", "No system detail in any answer of the run", ({ c }) => {
    for (const call of calls) {
      const failedTool = call.path === "/mcp" && /"isError":true|"error":\{/.test(call.text);
      const text = call.status >= 400 || failedTool ? call.text : "";
      if (text === "") continue;
      const leak = INSIDES.exec(text);
      if (leak) c.fail(`${call.scenario} ${call.method} ${call.path} → ${call.status} holds "${leak[0]}"`);
      const error = errorOf(call.json);
      if (call.status === 500) c.ok(error?.details.length === 0, `${call.scenario}: a 500 gives only the general message`);
    }
    return Promise.resolve();
  });
}
