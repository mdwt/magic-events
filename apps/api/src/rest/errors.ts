import { z } from "zod";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { AppError, unavailable, type ErrorCode, type ErrorDetail } from "@magic-events/core/shared/errors.ts";

// The one error format of the REST API:
//   { "error": { "code": "...", "message": "...", "details": [{ "path": "...", "message": "..." }], "requestId": "..." } }

export type ResponseErrorCode = ErrorCode | "internal_error";

export const STATUS_BY_CODE: Record<ResponseErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  not_acceptable: 406,
  conflict: 409,
  content_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal_error: 500,
  unavailable: 503,
};

export const MESSAGES = {
  internal: "Something went wrong on our side. Quote the request ID if you report it.",
  invalidInput: "The request is not valid.",
  invalidArguments: "The arguments do not fit the tool's input schema. The details say which fields are wrong and why.",
  notFound: "There is nothing at this address.",
} as const;

function errorSchema<C extends ResponseErrorCode>(code: C, description: string) {
  return z
    .object({
      error: z.object({
        code: z.literal(code),
        message: z.string().describe("What went wrong, written for the caller."),
        details: z
          .array(
            z.object({
              path: z.string().describe('Where in the input the problem is, such as "near.lat". Empty for the input as a whole.'),
              message: z.string(),
            }),
          )
          .describe("One entry per problem with the input. Empty when the error is not about the input."),
        requestId: z.string().describe("The request's ID, also sent in the x-request-id header."),
      }),
    })
    .describe(description);
}

// The error answers every route can give, to spread into a route's `response`.
export const errorResponses = {
  400: errorSchema("invalid_input", "The request is not valid. The details say which fields are wrong and why."),
  401: errorSchema("unauthenticated", "The API key is missing, unknown, disabled or expired."),
  403: errorSchema("forbidden", "The caller may not do this, or their tenant is suspended."),
  429: errorSchema("rate_limited", "Too many requests. Retry-After says how many seconds to wait."),
  500: errorSchema("internal_error", "Something went wrong on the server. Quote the request ID if you report it."),
  503: errorSchema("unavailable", "The service cannot answer for now, such as while its database is down. Retry-After says how many seconds to wait."),
};

// For a route that takes a body.
export const bodyErrorResponses = {
  413: errorSchema("content_too_large", "The request body is larger than the server takes."),
  415: errorSchema("unsupported_media_type", "The request body is not JSON. Send it with Content-Type: application/json."),
};

// For a route that creates something whose name must not be taken.
export const conflictResponse = {
  409: errorSchema("conflict", "It already exists: the details name the field that is taken."),
};

// For a route that exists only to refuse a method. Allow names the methods the address answers.
export const methodNotAllowedResponse = {
  405: errorSchema("method_not_allowed", "The address does not answer this method. Allow names the ones it does."),
};

// For the MCP endpoint, whose transport needs the caller to accept both JSON and an event stream.
export const notAcceptableResponse = {
  406: errorSchema("not_acceptable", "The Accept header must name both application/json and text/event-stream."),
};

// For a route that names something in its address, which may not exist.
export const notFoundResponse = {
  404: errorSchema("not_found", "There is nothing with this ID or slug."),
};

export interface ErrorBody {
  error: { code: ResponseErrorCode; message: string; details: ErrorDetail[]; requestId: string };
}

export interface ErrorReply {
  status: number;
  code: ResponseErrorCode;
  message: string;
  details: ErrorDetail[];
  // Sent as Retry-After, when it is known.
  retryAfterSeconds: number | undefined;
  // True for a failure on our side, which is logged in full. Of these, only unavailable tells the caller more than
  // the general message.
  system: boolean;
}

// Fastify's own errors about a request it could not read. Their messages are replaced with ours, so no library
// wording reaches the caller.
const UNREADABLE_REQUEST: Record<string, { code: ErrorCode; message: string }> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    code: "unsupported_media_type",
    message: "The content type is not supported. Send the body as JSON, with Content-Type: application/json.",
  },
  FST_ERR_CTP_BODY_TOO_LARGE: { code: "content_too_large", message: "The request body is too large. Send a smaller one." },
  FST_ERR_CTP_EMPTY_JSON_BODY: { code: "invalid_input", message: "The request body is empty. Send a JSON object." },
  FST_ERR_CTP_INVALID_JSON_BODY: { code: "invalid_input", message: "The request body is not valid JSON." },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    code: "invalid_input",
    message: "The Content-Length header does not match the body.",
  },
  FST_ERR_BAD_URL: { code: "invalid_input", message: "The address is not valid." },
  FST_ERR_MAX_PARAM_LENGTH: { code: "invalid_input", message: "A part of the address is too long." },
};

// Turns anything thrown while answering a request into the status and body the caller gets. isUnavailable says
// whether a system error means the database cannot be reached, which is answered with unavailable.
export function toErrorReply(error: unknown, isUnavailable: (error: unknown) => boolean = () => false): ErrorReply {
  if (!(error instanceof AppError) && isUnavailable(error)) return toErrorReply(unavailable(error));
  if (error instanceof AppError) {
    return {
      status: STATUS_BY_CODE[error.code],
      code: error.code,
      message: error.message,
      details: error.details ?? [],
      retryAfterSeconds: error.retryAfterSeconds,
      system: error.code === "unavailable",
    };
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      status: 400,
      code: "invalid_input",
      message: MESSAGES.invalidInput,
      details: error.validation.flatMap(validationDetails),
      retryAfterSeconds: undefined,
      system: false,
    };
  }

  const code = fastifyCode(error);
  const unreadable = UNREADABLE_REQUEST[code] ?? (code.startsWith("FST_ERR_") && isClientError(error) ? UNREADABLE : undefined);
  if (unreadable !== undefined) {
    return {
      status: STATUS_BY_CODE[unreadable.code],
      code: unreadable.code,
      message: unreadable.message,
      details: [],
      retryAfterSeconds: undefined,
      system: false,
    };
  }

  return {
    status: 500,
    code: "internal_error",
    message: MESSAGES.internal,
    details: [],
    retryAfterSeconds: undefined,
    system: true,
  };
}

export function errorBody(reply: Pick<ErrorReply, "code" | "message" | "details">, requestId: string): ErrorBody {
  return { error: { code: reply.code, message: reply.message, details: reply.details, requestId } };
}

function validationDetails(issue: {
  instancePath: string;
  message?: string | undefined;
  keyword: string;
  params: Record<string, unknown>;
}): ErrorDetail[] {
  const path = issue.instancePath.split("/").filter(Boolean).join(".");
  const keys = issue.params.keys;
  if (issue.keyword === "unrecognized_keys" && Array.isArray(keys)) {
    return keys.map((key) => ({ path: path ? `${path}.${String(key)}` : String(key), message: "Unknown field." }));
  }
  return [{ path, message: issue.message ?? "Not valid." }];
}

// Any other error of Fastify's that it raises with a 4xx status: something about the request it could not read.
const UNREADABLE = { code: "invalid_input", message: "The request could not be read." } as const;

function isClientError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
  return typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500;
}

function fastifyCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
}
