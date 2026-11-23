import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { record, send, type Call, type Client } from "./api.ts";
import type { ApiServer } from "./server.ts";

// The MCP side of the run: the official SDK's client over Streamable HTTP, as an AI agent connects, with every HTTP
// exchange it makes recorded like the REST calls.

export interface ToolAnswer {
  isError: boolean;
  structuredContent: unknown;
  // The text of the first content block: the error body when the call failed.
  text: string;
  // The request that carried the call.
  call: Call | undefined;
}

export interface McpSession {
  listTools(): Promise<{ name: string; description?: string | undefined; inputSchema: unknown }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
  close(): Promise<void>;
}

function bodyText(body: unknown): string {
  return typeof body === "string" ? body : "";
}

export async function connect(server: ApiServer, client: Client): Promise<McpSession> {
  let last: Call | undefined;
  const recordingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    const text = await response.clone().text();
    let json: unknown;
    try {
      json = text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      json = undefined;
    }
    let rpcMethod: string | undefined;
    try {
      const sent: unknown = JSON.parse(bodyText(init?.body));
      if (typeof sent === "object" && sent !== null && "method" in sent && typeof sent.method === "string") {
        rpcMethod = sent.method;
      }
    } catch {
      rpcMethod = undefined;
    }
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    last = record({
      server,
      method: init?.method ?? "GET",
      path: url.pathname,
      status: response.status,
      headers: response.headers,
      text,
      json,
      client,
      credential: "client",
      durationMs: 0,
      rpcMethod,
    });
    return response;
  };

  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${client.key}` } },
    fetch: recordingFetch,
  });
  const mcp = new McpClient({ name: "magic-events-e2e", version: "1.0.0" });
  await mcp.connect(transport);

  return {
    async listTools() {
      const listed = await mcp.listTools();
      return listed.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    },
    async callTool(name, args) {
      last = undefined;
      const result = await mcp.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
      return {
        isError: result.isError === true,
        structuredContent: result.structuredContent,
        text: content[0]?.text ?? "",
        call: last,
      };
    },
    async close() {
      await mcp.close();
    },
  };
}

// A JSON-RPC message sent as plain HTTP, for the refusals the SDK client hides: a tools/call with no session, as the
// endpoint is stateless.
export function rpc(
  server: ApiServer,
  client: Client | undefined,
  method: string,
  params: Record<string, unknown>,
  options: { authorization?: string; accept?: string } = {},
): Promise<Call> {
  return send(server, {
    method: "POST",
    path: "/mcp",
    client,
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    headers: { accept: options.accept ?? "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
}

// The tool call's result from a plain JSON-RPC answer.
export function toolResultOf(call: Call): { isError: boolean; structuredContent: unknown; text: string } | undefined {
  const json = (call.json ?? {}) as { result?: { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] } };
  if (json.result === undefined) return undefined;
  return {
    isError: json.result.isError === true,
    structuredContent: json.result.structuredContent,
    text: json.result.content?.[0]?.text ?? "",
  };
}
