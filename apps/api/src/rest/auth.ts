import type { FastifyContextConfig, FastifyInstance, FastifyRequest, FastifySchema, RouteOptions } from "fastify";
import type { Caller, Identity } from "@magic-events/core/identity/ports.ts";
import { errorResponses } from "./errors.ts";
import { addCallerToLogContext } from "./logging.ts";

// Every endpoint is authenticated and names the action it authorises, unless it is marked public. The health check
// is the one public route, so a load balancer or an uptime check needs no key.

// The one route with neither: @fastify/cors's catch-all OPTIONS route. Browsers send no credentials on a CORS
// preflight, so the plugin answers preflights in its own hook, before authentication.
function isCorsPreflightRoute(route: RouteOptions): boolean {
  return route.method === "OPTIONS" && route.url === "*";
}

// Makes the server fail to start when a route is registered without config.action or config.public, so none can
// be left open by forgetting. Added before any route is registered.
export function requireActionOnEveryRoute(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    if (route.config?.action !== undefined || route.config?.public === true || isCorsPreflightRoute(route)) return;
    const methods = Array.isArray(route.method) ? route.method.join(",") : route.method;
    throw new Error(`The route ${methods} ${route.url} has no config.action. Every route names the action it authorises.`);
  });
}

// The two ways to send the API key, as the OpenAPI document names them. Either one will do.
export const API_KEY_SECURITY: Record<string, string[]>[] = [{ bearer: [] }, { apiKeyHeader: [] }];

// What the OpenAPI document says of a route's authentication, worked out from the same config the hook reads, so the
// document cannot say otherwise than the server does. A public route asks for no key. Every other route states the
// API key on its own operation, with its 401 and 403 answers. Used by the swagger plugin's transform, for every route.
export function documentAuthentication(schema: FastifySchema | undefined, config: FastifyContextConfig | undefined): FastifySchema {
  if (config?.public === true) return { ...schema, security: [] };
  const response = typeof schema?.response === "object" && schema.response !== null ? schema.response : {};
  return {
    ...schema,
    security: API_KEY_SECURITY,
    response: { 401: errorResponses[401], 403: errorResponses[403], ...response },
  };
}

// The API key, from "Authorization: Bearer <key>" or from an x-api-key header. When Authorization is sent, it is the
// one read. Never from the address: a key there would end up in logs and browser histories.
export function credentialOf(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return match?.[1];
  }
  const header = request.headers["x-api-key"];
  const key = typeof header === "string" ? header.trim() : "";
  return key === "" ? undefined : key;
}

// The authenticated caller, for a handler of a route that is not public, where the hook has always set it. Asked for
// on a public route, it is a mistake in the code, so it fails as a system error.
export function callerOf(request: FastifyRequest): Caller {
  if (request.caller === null) throw new Error(`${request.method} ${request.routeOptions.url ?? ""} has no caller.`);
  return request.caller;
}

// Authenticates every request to a route that is not public, then authorises the route's action. A request that
// matches no route is authenticated too, so a caller without a valid key cannot learn which paths exist.
export function addAuthenticationHook(app: FastifyInstance, identity: Identity): void {
  // Null to start with, as Fastify asks of a decorator that holds an object, and set for each request below.
  app.decorateRequest("caller", null);
  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.config.public === true) return;
    const caller = await identity.authenticate(credentialOf(request));
    request.caller = caller;
    addCallerToLogContext(request, caller);
    const action = request.routeOptions.config.action;
    if (action !== undefined) identity.authorise(caller, action);
  });
}
