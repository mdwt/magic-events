import type { Action, Caller } from "@magic-events/core/identity/ports.ts";

// What the server adds to Fastify's own types.
declare module "fastify" {
  interface FastifyRequest {
    // Who is calling. The authentication hook sets it before any handler runs on a route that is not public; a public
    // route has none. A handler reads it with callerOf.
    caller: Caller | null;
  }

  interface FastifyContextConfig {
    // What the route does, which Identity authorises for the caller. A route with neither this nor public stops
    // the server starting.
    action?: Action;
    // True for a route anyone may call, with no API key.
    public?: true;
  }
}
