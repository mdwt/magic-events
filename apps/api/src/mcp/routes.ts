import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Catalogue } from "@magic-events/core/catalogue/ports.ts";
import type { Identity } from "@magic-events/core/identity/ports.ts";
import type { Organizations } from "@magic-events/core/organizations/ports.ts";
import { AppError } from "@magic-events/core/shared/errors.ts";
import { errorResponses, methodNotAllowedResponse } from "../rest/errors.ts";
import { createMcpServer } from "./server.ts";

// The MCP endpoint: Streamable HTTP, stateless. Every POST gets a fresh server and transport, answered as JSON.
// The global hook has authenticated the caller and authorised mcp.use before anything here runs.

const jsonRpcMessage = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
});

const jsonRpcError = z
  .object({
    jsonrpc: z.literal("2.0"),
    error: z.object({ code: z.number().int(), message: z.string() }),
    id: z.union([z.string(), z.number(), z.null()]),
  })
  .describe("A JSON-RPC error.");

// What the transport answers: a JSON-RPC message or a batch, an error included.
const jsonRpcAnswer = z.union([jsonRpcMessage, z.array(jsonRpcMessage)]);

const TAGS = ["MCP"];

function sendJsonRpcError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.code(status).type("application/json").send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

// The DNS rebinding protection the MCP SDK describes: the Host must be one this server answers to, and a browser's
// Origin must be the one allowed origin. The SDK leaves this check to the HTTP framework.
function guardHostAndOrigin(allowedHosts: string[], allowedOrigin: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let hostname: string | undefined;
    try {
      hostname = request.headers.host === undefined ? undefined : new URL(`http://${request.headers.host}`).hostname;
    } catch {
      hostname = undefined;
    }
    if (hostname === undefined || !allowedHosts.includes(hostname)) {
      request.log.warn({ host: request.headers.host }, "MCP request refused: host not allowed");
      await sendJsonRpcError(reply, 403, "This host is not allowed.");
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
      request.log.warn({ origin }, "MCP request refused: origin not allowed");
      await sendJsonRpcError(reply, 403, "This origin is not allowed.");
    }
  };
}

// The request as the SDK's web-standard transport takes it. The credential is left out: the caller is already known.
function toWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === "authorization" || name === "x-api-key" || name === "cookie") continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return new Request(`${request.protocol}://${request.host}${request.url}`, { method: request.method, headers });
}

export const mcpRoutes: FastifyPluginAsyncZod<{
  identity: Identity;
  catalogue: Catalogue;
  organizations: Organizations;
  allowedHosts: string[];
  allowedOrigin: string;
}> = (app, { identity, catalogue, organizations, allowedHosts, allowedOrigin }) => {
  const guard = guardHostAndOrigin(allowedHosts, allowedOrigin);

  app.post(
    "/mcp",
    {
      config: { action: "mcp.use" },
      onRequest: guard,
      schema: {
        operationId: "mcp",
        summary: "MCP endpoint",
        description:
          "The Model Context Protocol endpoint, over Streamable HTTP without sessions. Connect an MCP client to it " +
          "with the API key in the Authorization header. It offers the same search and onboarding as the REST API.",
        tags: TAGS,
        body: z.union([jsonRpcMessage, z.array(jsonRpcMessage).min(1)]).describe("A JSON-RPC message, or a batch."),
        response: {
          200: jsonRpcAnswer.describe("The JSON-RPC answer."),
          202: z.undefined().describe("A notification or response was accepted. There is no body."),
          406: jsonRpcError.describe("The Accept header must name both application/json and text/event-stream."),
          415: jsonRpcError.describe("The body must be application/json."),
          ...errorResponses,
          // The transport answers a message it cannot handle, and its own failures, in JSON-RPC form.
          400: z.union([errorResponses[400], jsonRpcError]).describe("The request is not valid."),
          403: z.union([errorResponses[403], jsonRpcError]).describe("Not allowed: the caller, the host or the origin."),
          500: z.union([errorResponses[500], jsonRpcError]).describe("Something went wrong on the server."),
        },
      },
    },
    async (request, reply) => {
      const server = createMcpServer({ caller: request.caller, identity, logger: request.log }, { catalogue, organizations });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        // With JSON answers the response is complete here, so the server and transport can be closed after it.
        const response = await transport.handleRequest(toWebRequest(request), { parsedBody: request.body });
        const text = await response.text();
        reply.code(response.status);
        return text === "" ? undefined : jsonRpcAnswer.parse(JSON.parse(text));
      } finally {
        await transport.close();
        await server.close();
      }
    },
  );

  const notAllowed = {
    config: { action: "mcp.use" as const },
    onRequest: guard,
    schema: {
      tags: TAGS,
      description: "Not offered: this MCP endpoint is stateless and has no event stream or session to end.",
      response: { ...methodNotAllowedResponse, ...errorResponses },
    },
  };
  // In the API's one error format, as every other refusal of this endpoint at the HTTP level.
  const refuse = (_request: FastifyRequest, reply: FastifyReply): never => {
    reply.header("allow", "POST");
    throw new AppError(
      "method_not_allowed",
      "This MCP endpoint takes POST only: it is stateless, with no event stream to open or session to end.",
    );
  };

  app.get("/mcp", { ...notAllowed, schema: { ...notAllowed.schema, operationId: "mcpGet", summary: "Not offered" } }, refuse);
  app.delete(
    "/mcp",
    { ...notAllowed, schema: { ...notAllowed.schema, operationId: "mcpDelete", summary: "Not offered" } },
    refuse,
  );

  return Promise.resolve();
};
