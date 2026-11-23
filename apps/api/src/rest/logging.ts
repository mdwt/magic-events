import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Caller } from "../core/identity/ports.ts";
import { logContext } from "../core/shared/log-context.ts";

// Every log line of a request carries its log context: the request ID and, once authenticated, who is calling.
// The context lives in AsyncLocalStorage, so the lines the core services write carry it too, and the logger adds it
// to every line. Fastify's own per-request logger therefore binds nothing itself.

// An incoming x-request-id is used only when it is a plain token, so a caller cannot inject anything into the logs.
const SANE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestId(raw: IncomingMessage): string {
  const incoming = raw.headers["x-request-id"];
  return typeof incoming === "string" && SANE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

const contexts = new WeakMap<FastifyRequest, Record<string, unknown>>();

function contextOf(request: FastifyRequest): Record<string, unknown> {
  return contexts.get(request) ?? { requestId: request.id };
}

// Adds who is calling to every line logged for the rest of the request.
export function addCallerToLogContext(request: FastifyRequest, caller: Caller): void {
  Object.assign(contextOf(request), {
    tenantId: caller.tenant?.id ?? null,
    userId: caller.userId,
    callerKind: caller.kind,
    role: caller.role,
    credentialId: caller.credentialId,
  });
}

// Fastify's request lines: started at debug, completed at info with the status and duration. Both run outside the
// request's async context, so they add the log context themselves.
export class RequestLogController extends LogController {
  override incomingRequest(request: FastifyRequest): void {
    request.log.debug({ ...contextOf(request), method: request.method, url: request.url }, "Request started");
  }

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    const fields = {
      ...contextOf(request),
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    };
    if (error) request.log.error({ ...fields, err: error }, "Request failed while sending the answer");
    else request.log.info(fields, "Request completed");
  }
}

// Opens the log context for each request and enters it again where Fastify leaves it. The body is read in the
// socket's own async context, so the hooks after it and the handler run outside the one opened at the start.
// Added to the root instance first, so every other hook runs inside the context.
export function addLogContextHooks(app: FastifyInstance): void {
  app.addHook("onRequest", (request, _reply, done) => {
    const context = { requestId: request.id };
    contexts.set(request, context);
    logContext.run(context, done);
  });
  app.addHook("preValidation", (request, _reply, done) => {
    logContext.run(contextOf(request), done);
  });
}
