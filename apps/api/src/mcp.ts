import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { sql, type Db } from "@magic-events/db";

function createMcpServer(db: Db) {
  const server = new McpServer({ name: "magic-events", version: "0.0.0" });

  server.registerTool(
    "ping",
    { title: "Ping", description: "Check that the MCP server and database are reachable." },
    async () => {
      await db.execute(sql`select 1`);
      return { content: [{ type: "text", text: "pong" }] };
    },
  );

  return server;
}

// Stateless Streamable HTTP: a fresh server + transport per request.
export async function mcpRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.post("/mcp", async (request, reply) => {
    const server = createMcpServer(opts.db);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  const methodNotAllowed = {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  };
  app.get("/mcp", async (_request, reply) => reply.code(405).send(methodNotAllowed));
  app.delete("/mcp", async (_request, reply) => reply.code(405).send(methodNotAllowed));
}
