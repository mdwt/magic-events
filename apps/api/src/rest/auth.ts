import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import type { Identity } from "../core/identity/ports.ts";
import { addCallerToLogContext } from "./logging.ts";

// Every endpoint is authenticated, with no exception, and every route names the action it authorises.

// The one route without an action: @fastify/cors's catch-all OPTIONS route. Browsers send no credentials on a CORS
// preflight, so the plugin answers preflights in its own hook, before authentication.
function isCorsPreflightRoute(route: RouteOptions): boolean {
  return route.method === "OPTIONS" && route.url === "*";
}

// Makes the server fail to start when a route is registered without config.action, so none can be forgotten.
// Added before any route is registered.
export function requireActionOnEveryRoute(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    if (route.config?.action !== undefined || isCorsPreflightRoute(route)) return;
    const methods = Array.isArray(route.method) ? route.method.join(",") : route.method;
    throw new Error(`The route ${methods} ${route.url} has no config.action. Every route names the action it authorises.`);
  });
}

// The API key, from "Authorization: Bearer <key>" or from an x-api-key header.
export function credentialOf(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return match?.[1];
  }
  const header = request.headers["x-api-key"];
  return typeof header === "string" ? header.trim() : undefined;
}

// Authenticates every request, then authorises the route's action. A request that matches no route is
// authenticated too, so a caller without a valid key cannot learn which paths exist.
export function addAuthenticationHook(app: FastifyInstance, identity: Identity): void {
  app.decorateRequest("caller");
  app.addHook("onRequest", async (request) => {
    const caller = await identity.authenticate(credentialOf(request));
    request.caller = caller;
    addCallerToLogContext(request, caller);
    const action = request.routeOptions.config.action;
    if (action !== undefined) identity.authorise(caller, action);
  });
}
