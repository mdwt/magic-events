import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import formats from "ajv-formats";
import { ROOT } from "./process.ts";

// The committed OpenAPI document: the list of operations every run must call, and the schema each answer is checked
// against. It is read once, when the run starts.

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  pattern: RegExp;
  // The statuses the document lists for it.
  statuses: string[];
}

export const OPENAPI_PATH = join(ROOT, "apps/api/openapi.json");
export const committedDocument: unknown = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));

interface Document {
  paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
}

const document = committedDocument as Document;
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export const operations: Operation[] = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods)
    .filter(([method]) => METHODS.has(method))
    .map(([method, operation]) => ({
      operationId: operation.operationId ?? `${method.toUpperCase()} ${path}`,
      method: method.toUpperCase(),
      path,
      pattern: new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`),
      statuses: Object.keys(operation.responses ?? {}),
    })),
);

export function operationOf(method: string, url: string): Operation | undefined {
  const path = url.split("?")[0] ?? url;
  return operations.find((operation) => operation.method === method.toUpperCase() && operation.pattern.test(path));
}

// The whole document is the one schema, so its internal $refs resolve; each answer is checked against the schema at
// its operation's response.
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
formats.default(ajv);
ajv.addSchema(committedDocument as object, "openapi");

const validators = new Map<string, ValidateFunction | null>();

function pointer(...parts: string[]): string {
  return parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

function validatorFor(operation: Operation, status: string): ValidateFunction | null {
  const id = `${operation.operationId} ${status}`;
  const known = validators.get(id);
  if (known !== undefined) return known;
  const methods = document.paths[operation.path] ?? {};
  const responses = methods[operation.method.toLowerCase()]?.responses ?? {};
  const response = responses[status] as { content?: Record<string, { schema?: unknown }> } | undefined;
  const hasSchema = response?.content?.["application/json"]?.schema !== undefined;
  const validate = hasSchema
    ? ajv.compile({
        $ref: `openapi#/${pointer("paths", operation.path, operation.method.toLowerCase(), "responses", status, "content", "application/json", "schema")}`,
      })
    : null;
  validators.set(id, validate);
  return validate;
}

// What is wrong with an answer, against the document: an undocumented status, or a body that does not fit.
export function problemsWith(operation: Operation, status: number, body: unknown): string[] {
  const key = String(status);
  if (!operation.statuses.includes(key)) return [`status ${key} is not documented for ${operation.operationId}`];
  const validate = validatorFor(operation, key);
  if (validate === null) return [];
  if (validate(body)) return [];
  return (validate.errors ?? []).slice(0, 5).map((error) => `${error.instancePath || "/"} ${error.message ?? "is not valid"}`);
}
