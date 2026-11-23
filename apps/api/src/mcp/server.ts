import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Catalogue } from "@magic-events/core/catalogue/ports.ts";
import { registerCatalogueTools } from "./tools/catalogue.ts";
import { answerToolCalls, type ToolDeps } from "./tool.ts";

export const MCP_SERVER_NAME = "magic-events";

// What an agent is told once, when it connects, before it reads any tool. It is read on every connection, so it
// stays short: what the feed is, which tool to use when, the one rule that trips agents up, how to read an answer
// and what to do with a refusal. The tools' own descriptions hold the detail.
export const INSTRUCTIONS = `magic-events is a feed of what is on in a place while a traveller is there: festivals, \
concerts, sports matches, markets, theatre runs, exhibitions and seasons such as whale season. Travel agents and \
travel apps use it to plan trips, often months ahead. It covers Hermanus, South Africa, and the towns near it, up to \
24 months ahead.

Two tools, both read-only:
- search_experiences: what is on in a place between two dates. Start here. The smallest call is \
{"location": "hermanus", "from": "2027-06-20", "to": "2027-06-30"}.
- get_experience_changes: what changed since you last searched the same place and dates. Use it when checking back \
on a trip.

What must hold goes in the filters (place, dates, radiusKm, attributes, tags, status, bookable): they are exact and \
never loosened. What the traveller likes goes in query, in plain words: it only puts the best matches first and never \
adds or removes a result.

Reading a result:
- sessions are the days it is on inside the dates you asked for; it is on no other day in them. A session with \
precision month or year means it is on in that month or year and its days are not announced yet.
- status: expected (an annual event likely to come round again, not yet announced: its dates are likely, not \
promised), announced, confirmed, or postponed (not on its dates, new dates unknown).
- bookable is true only when it is confirmed, booking is open and there is a link to book through: bookingUrl, or \
failing that pageUrl. Never tell a traveller something can be booked when bookable is false.
- total is how many match across all pages. Page with limit (at most 100, 20 by default) and offset.

A refused call is a tool error whose text is JSON: {"error": {"code", "message", "details", "requestId"}}. Each \
detail names a field and what is wrong with it: fix those fields and call again. unavailable means try again in a \
few seconds; internal_error is a fault on our side, so give the requestId to whoever reports it.`;

// A fresh MCP server for one request, with the tools bound to the caller of that request.
export function createMcpServer(deps: ToolDeps, catalogue: Catalogue): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      title: "magic-events experience feed",
      version: "1.0.0",
      description: "What is on in Hermanus, South Africa, and nearby while a traveller is there, for planning trips.",
    },
    { instructions: INSTRUCTIONS },
  );
  registerCatalogueTools(server, deps, catalogue);
  answerToolCalls(server);
  return server;
}
