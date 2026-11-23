import { calls, send } from "../harness/api.ts";
import { admin } from "../harness/cli.ts";
import { WINTER } from "../harness/feed.ts";
import { operations } from "../harness/openapi.ts";
import { scenario } from "../harness/scenario.ts";
import { client, mainServer } from "../harness/state.ts";

// Every operation of apps/api/openapi.json: called at least once with a valid request, answered as its schema says,
// and called in each documented refusal that applies. The run fails if the document lists an operation, or a
// status of one, that no request reached.

// A failure on our side cannot be caused from outside without breaking the system, so 500 is left out.
const NOT_FORCEABLE = new Set(["500"]);

export function registerEndpoints(): void {
  scenario("API", "Every operation of the OpenAPI document", async ({ c }) => {
    const main = mainServer();
    const person = client("agency person");
    const big = "x".repeat(70_000);
    const mcpHeaders = { accept: "application/json, text/event-stream" };

    // The refusals that apply to each operation, sent here so none depends on a scenario's path through the run.
    const suspended = await admin(["tenant", "update", "--slug", "second-example-agency", "--status", "suspended"]);
    if (suspended.code !== 0) {
      c.fail(`Could not suspend the second agency for the 403 of each operation: ${suspended.stderr.trim()}`);
    } else {
      try {
        for (const operation of operations) {
          const path = operation.path.replace(/\{[^}]+\}/g, "x");
          const body = operation.method === "POST" ? { ...WINTER } : undefined;
          await send(main, {
            method: operation.method,
            path,
            client: client("second agent"),
            headers: operation.path === "/mcp" ? mcpHeaders : {},
            ...(body === undefined ? {} : { body }),
          });
        }
      } finally {
        await admin(["tenant", "update", "--slug", "second-example-agency", "--status", "active"]);
      }
    }
    for (const operation of operations) {
      const path = operation.path.replace(/\{[^}]+\}/g, "x");
      const headers = operation.path === "/mcp" ? mcpHeaders : {};
      const method = operation.method;
      if (operation.statuses.includes("401")) await send(main, { method, path, headers });
      if (method === "GET" || method === "DELETE") {
        await send(main, { method, path: `${path}?unexpected=1`, client: person, headers });
      } else {
        await send(main, { method, path, client: person, headers, body: path === "/mcp" ? [] : { unexpected: 1 } });
        await send(main, { method, path, client: person, headers, rawBody: JSON.stringify({ ...WINTER, padding: big }) });
        await send(main, { method, path, client: person, headers, rawBody: "plain text", contentType: "text/plain" });
      }
      if (operation.statuses.includes("406")) {
        await send(main, { method, path, client: person, headers: { accept: "application/json" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      }
      if (operation.path === "/mcp" && method === "POST") {
        await send(main, { method, path, client: client("agency agent"), headers, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
      }
    }

    for (const operation of operations) {
      const reached = calls.filter((call) => call.operationId === operation.operationId);
      const statuses = new Set(reached.map((call) => String(call.status)));
      // An operation that only refuses, such as GET /mcp, documents no success.
      const succeeds = operation.statuses.some((status) => status.startsWith("2"));
      if (succeeds) c.ok([...statuses].some((status) => status.startsWith("2")), `${operation.operationId} was never answered with success`);
      for (const status of operation.statuses) {
        if (NOT_FORCEABLE.has(status) || statuses.has(status)) continue;
        // A route that refuses every request answers 405 before it reads anything, so its 400 cannot be reached.
        if (!succeeds && status === "400") c.note(`${operation.operationId} documents 400, which it cannot answer: it refuses before reading the request`);
        else c.fail(`${operation.operationId} ${status} is documented, and no request of the run got it`);
      }
      for (const status of statuses) {
        c.ok(operation.statuses.includes(status), `${operation.operationId} answered ${status}, which the document does not list`);
      }
    }
    const problems = [...new Set(calls.flatMap((call) => call.schemaProblems))];
    for (const problem of problems) c.fail(`An answer does not fit its schema: ${problem}`);
    // An unknown address is 401 without a key and 404 with one, by design (E2E-37).
    const unknown = calls.filter((call) => call.operationId === null && call.status !== 404 && call.status !== 401);
    for (const call of unknown) c.fail(`${call.method} ${call.path} answered ${call.status} and is in no operation of the document`);
    c.saw(`${operations.length} operations in apps/api/openapi.json, each called with success and in every documented refusal but 500; ${calls.length} answers, ${problems.length} against their schema`);
    c.note(`${calls.length} requests over the run reached ${new Set(calls.map((call) => call.operationId)).size - 1} operations. 500 cannot be caused from outside.`);
  });
}
