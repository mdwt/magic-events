import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Catalogue } from "@magic-events/core/catalogue/ports.ts";
import type { Identity } from "@magic-events/core/identity/ports.ts";
import { AppError } from "@magic-events/core/shared/errors.ts";
import {
  bodyErrorResponses,
  errorResponses,
  methodNotAllowedResponse,
  notAcceptableResponse,
} from "../rest/errors.ts";
import { createMcpServer } from "./server.ts";

// The MCP endpoint: Streamable HTTP, stateless. Every POST gets a fresh server and transport, answered as JSON.
// The global hook has authenticated the caller and authorised mcp.use before anything here runs. A refusal at the
// HTTP level, the transport's included, is in the API's one error format; JSON-RPC answers, errors among them, come
// with 200.

const jsonRpcMessage = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
});

// What the transport answers: a JSON-RPC message or a batch, an error included.
const jsonRpcAnswer = z.union([jsonRpcMessage, z.array(jsonRpcMessage)]);

const TAGS = ["MCP"];

// The transport refuses a request it cannot take with an HTTP error and a JSON-RPC error body, which the protocol
// allows but does not require. It becomes the API's own error: the transport's message says what is wrong with the
// request in the protocol's terms, and no more. Any other failure of the transport's is a system error.
function transportRefusal(status: number, text: string): Error {
  let message = "";
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    message = "";
  }
  if (status === 406) {
    return new AppError("not_acceptable", "Send an Accept header that names both application/json and text/event-stream.");
  }
  if (status === 415) return new AppError("unsupported_media_type", "Send the body as JSON, with Content-Type: application/json.");
  if (status === 413) return new AppError("content_too_large", "The request body is too large. Send a smaller one.");
  if (status === 400) return new AppError("invalid_input", `The MCP request is not valid: ${message || "the transport refused it"}.`);
  return new Error(`The MCP transport answered ${status}: ${message}`);
}

// The DNS rebinding protection the MCP SDK describes: the Host must be one this server answers to, and a browser's
// Origin must be the one allowed origin. The SDK leaves this check to the HTTP framework.
function guardHostAndOrigin(allowedHosts: string[], allowedOrigin: string) {
  return async (request: FastifyRequest): Promise<void> => {
    let hostname: string | undefined;
    try {
      hostname = request.headers.host === undefined ? undefined : new URL(`http://${request.headers.host}`).hostname;
    } catch {
      hostname = undefined;
    }
    if (hostname === undefined || !allowedHosts.includes(hostname)) {
      request.log.warn({ host: request.headers.host }, "MCP request refused: host not allowed");
      throw new AppError("forbidden", "This host is not allowed. Call the MCP endpoint at the server's own address.");
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
      request.log.warn({ origin }, "MCP request refused: origin not allowed");
      throw new AppError("forbidden", "This origin is not allowed to call the MCP endpoint.");
    }
    return Promise.resolve();
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
  allowedHosts: string[];
  allowedOrigin: string;
  isUnavailable: (error: unknown) => boolean;
}> = (app, { identity, catalogue, allowedHosts, allowedOrigin, isUnavailable }) => {
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
          "with the API key in the Authorization header. It offers a client's two tools, search_experiences and get_experience_changes, the same as the REST API's search and changes.",
        tags: TAGS,
        body: z.union([jsonRpcMessage, z.array(jsonRpcMessage).min(1)]).describe("A JSON-RPC message, or a batch."),
        response: {
          200: jsonRpcAnswer.describe("The JSON-RPC answer."),
          202: z.undefined().describe("A notification or response was accepted. There is no body."),
          ...errorResponses,
          ...bodyErrorResponses,
          ...notAcceptableResponse,
        },
      },
    },
    async (request, reply) => {
      const server = createMcpServer(
        { caller: request.caller, identity, logger: request.log, requestId: request.id, isUnavailable },
        catalogue,
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        // With JSON answers the response is complete here, so the server and transport can be closed after it.
        const response = await transport.handleRequest(toWebRequest(request), { parsedBody: request.body });
        const text = await response.text();
        if (response.status >= 400) throw transportRefusal(response.status, text);
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
