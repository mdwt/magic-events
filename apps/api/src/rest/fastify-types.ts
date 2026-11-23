import type { Action, Caller } from "../core/identity/ports.ts";

// What the server adds to Fastify's own types.
declare module "fastify" {
  interface FastifyRequest {
    // Who is calling. The authentication hook sets it before any handler runs, so every handler can rely on it.
    caller: Caller;
  }

  interface FastifyContextConfig {
    // What the route does, which Identity authorises for the caller. A route without one stops the server starting.
    action?: Action;
  }
}
