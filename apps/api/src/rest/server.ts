import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Catalogue } from "@magic-events/core/catalogue/ports.ts";
import type { Identity } from "@magic-events/core/identity/ports.ts";
import { AppError } from "@magic-events/core/shared/errors.ts";
import type { ApiSettings } from "@magic-events/core/shared/settings.ts";
import { mcpRoutes } from "../mcp/routes.ts";
import { addAuthenticationHook, requireActionOnEveryRoute } from "./auth.ts";
import { errorBody, MESSAGES, toErrorReply } from "./errors.ts";
import "./fastify-types.ts";
import { addLogContextHooks, RequestLogController, requestId } from "./logging.ts";
import { catalogueRoutes } from "./routes/catalogue.ts";
import { platformRoutes } from "./routes/platform.ts";

export interface ServerDeps {
  settings: ApiSettings;
  logger: FastifyBaseLogger;
  services: { identity: Identity; catalogue: Catalogue };
  // A trivial query, for the health check.
  checkDatabase: () => Promise<void>;
  // Whether a system error means the database cannot be reached. Such a failure is answered 503, not 500.
  isUnavailable: (error: unknown) => boolean;
}

// Sends the one error format, and logs the failure: a refused call at warn with the reason, a system error at error
// in full, with its cause. A system error's own message never reaches the caller.
function sendError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  isUnavailable: (error: unknown) => boolean,
): FastifyReply {
  const answer = toErrorReply(error, isUnavailable);
  if (answer.system) {
    request.log.error(
      { requestId: request.id, statusCode: answer.status, code: answer.code, err: error },
      answer.code === "unavailable" ? "Request failed: the database cannot be reached" : "Request failed",
    );
  } else {
    request.log.warn(
      { requestId: request.id, statusCode: answer.status, code: answer.code, reason: answer.message, details: answer.details },
      "Request refused",
    );
  }
  if (answer.status === 401) reply.header("www-authenticate", 'Bearer realm="magic-events"');
  if (answer.retryAfterSeconds !== undefined) reply.header("retry-after", String(answer.retryAfterSeconds));
  return reply.code(answer.status).type("application/json").send(errorBody(answer, request.id));
}

// Records the methods every route answers, so that a request to a known address with another method can be answered
// 405 with Allow rather than 404. Added before any route is registered.
function recordRouteMethods(app: FastifyInstance): (url: string) => string[] {
  const routes: { pattern: RegExp; methods: string[] }[] = [];
  app.addHook("onRoute", (route) => {
    // @fastify/cors's catch-all OPTIONS route answers every address.
    if (route.url === "*") return;
    const segments = route.url.split("/").map((segment) =>
      segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    routes.push({
      pattern: new RegExp(`^${segments.join("/")}$`),
      methods: Array.isArray(route.method) ? route.method : [route.method],
    });
  });
  return (url) => {
    const path = url.split("?")[0] ?? url;
    const methods = routes.filter((route) => route.pattern.test(path)).flatMap((route) => route.methods);
    return [...new Set(methods)].sort();
  };
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { settings } = deps;

  const app = Fastify({
    loggerInstance: deps.logger,
    logController: new RequestLogController(),
    // The request ID is in every line's log context, so the per-request logger binds nothing of its own.
    childLoggerFactory: (logger, _bindings, options) => logger.child({}, options),
    genReqId: requestId,
    requestIdHeader: false,
    bodyLimit: settings.bodyLimitBytes,
    connectionTimeout: 60_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    // While closing, requests still in flight are answered normally rather than with Fastify's own 503 body.
    return503OnClosing: false,
    // Addresses Fastify cannot route, such as a malformed percent-encoding, get the same error format.
    frameworkErrors: (error, request, reply) => {
      reply.header("x-request-id", request.id).header("cache-control", "no-store");
      sendError(error, request, reply, deps.isUnavailable);
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Every body is JSON. Without Fastify's plain-text parser, any other content type is answered 415.
  app.removeContentTypeParser("text/plain");

  // Before anything else, so every later hook and route runs inside the request's log context.
  addLogContextHooks(app);
  requireActionOnEveryRoute(app);
  const methodsAt = recordRouteMethods(app);
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id).header("cache-control", "no-store");
    done();
  });

  await app.register(helmet);
  await app.register(cors, { origin: settings.corsOrigin, strictPreflight: false });
  // Per address, before any credential is checked. The hook is added here so it runs before authentication.
  await app.register(rateLimit, {
    global: false,
    max: settings.rateLimitMax,
    timeWindow: settings.rateLimitWindowSeconds * 1000,
    errorResponseBuilder: (_request, context) => {
      const seconds = Math.max(1, Math.ceil(context.ttl / 1000));
      return new AppError("rate_limited", `Too many requests from this address. Try again in ${seconds} seconds.`, undefined, {
        retryAfterSeconds: seconds,
      });
    },
  });
  app.addHook("onRequest", app.rateLimit());
  addAuthenticationHook(app, deps.services.identity);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "magic-events",
        version: "1.0.0",
        description:
          "What is on in a place while a traveller is there: festivals, concerts, matches, markets, shows, " +
          "exhibitions and seasons. Every endpoint needs an API key.",
      },
      components: {
        securitySchemes: {
          bearer: {
            type: "http",
            scheme: "bearer",
            description: "The API key, as: Authorization: Bearer <key>.",
          },
          apiKeyHeader: { type: "apiKey", in: "header", name: "x-api-key", description: "The API key, as: x-api-key: <key>." },
        },
      },
      security: [{ bearer: [] }, { apiKeyHeader: [] }],
    },
    transform: jsonSchemaTransform,
  });

  app.setErrorHandler((error, request, reply) => sendError(error, request, reply, deps.isUnavailable));
  // Reached only once the caller is authenticated, so a caller without a valid key learns nothing of the paths.
  app.setNotFoundHandler((request, reply) => {
    const allowed = methodsAt(request.url);
    if (allowed.length === 0) {
      return sendError(new AppError("not_found", MESSAGES.notFound), request, reply, deps.isUnavailable);
    }
    reply.header("allow", allowed.join(", "));
    const message = `This address does not answer ${request.method}. Use ${allowed.join(" or ")}.`;
    return sendError(new AppError("method_not_allowed", message), request, reply, deps.isUnavailable);
  });

  await app.register(platformRoutes, { checkDatabase: deps.checkDatabase });
  await app.register(mcpRoutes, {
    identity: deps.services.identity,
    catalogue: deps.services.catalogue,
    allowedHosts: settings.allowedHosts,
    allowedOrigin: settings.corsOrigin,
    isUnavailable: deps.isUnavailable,
  });
  await app.register(catalogueRoutes, { prefix: "/v1", catalogue: deps.services.catalogue });

  return app;
}
