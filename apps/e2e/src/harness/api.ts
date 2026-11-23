import { operationOf, problemsWith } from "./openapi.ts";
import type { ApiServer } from "./server.ts";

// The REST side of the run: every request the suite sends goes through here, so each is recorded with the scenario
// that sent it, the operation it reached and the request ID it got back, for the endpoint and log checks.

// Who is calling: a key the run holds, with what the system knows about it.
export interface Client {
  label: string;
  key: string;
  email: string;
  userId: string;
  tenantId: string | null;
  tenantSlug: string | null;
  kind: "person" | "agent";
  role: "client" | "system_admin";
  credentialId: string;
}

export interface Call {
  scenario: string;
  server: ApiServer;
  method: string;
  path: string;
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
  requestId: string | null;
  operationId: string | null;
  client: Client | undefined;
  // How the request authenticated, when it was not with a client's key.
  credential: "client" | "none" | "invalid";
  durationMs: number;
  // The JSON-RPC method of an MCP request, when it is one.
  rpcMethod?: string | undefined;
  // What the OpenAPI document says is wrong with the answer.
  schemaProblems: string[];
}

export const calls: Call[] = [];

let scenario = "setup";

export function setScenario(id: string): void {
  scenario = id;
}

export function currentScenario(): string {
  return scenario;
}

export interface RequestOptions {
  method?: string;
  path: string;
  client?: Client | undefined;
  // A raw Authorization header, such as a malformed one, in place of the client's key.
  authorization?: string;
  // The key in x-api-key rather than Authorization.
  apiKeyHeader?: boolean;
  body?: unknown;
  // A body sent as it is, such as one that is not JSON.
  rawBody?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
}

function parse(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function rpcMethodOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (Array.isArray(body)) return body.map(rpcMethodOf).filter(Boolean).join(",");
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

// Records an exchange made by another client, such as the MCP SDK's, as if the suite had made it here.
export function record(entry: Omit<Call, "scenario" | "operationId" | "schemaProblems" | "requestId">): Call {
  const operation = operationOf(entry.method, entry.path);
  const call: Call = {
    ...entry,
    scenario,
    requestId: entry.headers.get("x-request-id"),
    operationId: operation?.operationId ?? null,
    schemaProblems:
      operation === undefined || entry.json === undefined
        ? []
        : problemsWith(operation, entry.status, entry.json).map((problem) => `${operation.operationId} ${entry.status}: ${problem}`),
  };
  calls.push(call);
  return call;
}

export async function send(server: ApiServer, options: RequestOptions): Promise<Call> {
  const method = options.method ?? (options.body === undefined && options.rawBody === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { ...options.headers };
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  else if (options.client !== undefined) {
    if (options.apiKeyHeader === true) headers["x-api-key"] = options.client.key;
    else headers.authorization = `Bearer ${options.client.key}`;
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && options.contentType !== null) headers["content-type"] = options.contentType ?? "application/json";

  const started = performance.now();
  const response = await fetch(`${server.baseUrl}${options.path}`, { method, headers, body });
  const text = await response.text();
  const credential = options.authorization !== undefined ? "invalid" : options.client === undefined ? "none" : "client";
  return record({
    server,
    method,
    path: options.path,
    status: response.status,
    headers: response.headers,
    text,
    json: parse(text),
    client: options.authorization === undefined ? options.client : undefined,
    credential,
    durationMs: Math.round(performance.now() - started),
    rpcMethod: options.path === "/mcp" ? rpcMethodOf(options.body) : undefined,
  });
}

// The error body of the one error format, or undefined when the answer is not one.
export interface ErrorBody {
  code: string;
  message: string;
  details: { path: string; message: string }[];
  requestId: string;
}

export function errorOf(json: unknown): ErrorBody | undefined {
  if (typeof json !== "object" || json === null || !("error" in json)) return undefined;
  const error = json.error;
  if (typeof error !== "object" || error === null) return undefined;
  return error as ErrorBody;
}
