import pino from "pino";
import { logContext } from "../../core/shared/log-context.ts";
import type { ApiSettings } from "../../core/shared/settings.ts";

// Credentials never reach the logs, wherever a header object is logged.
const REDACT = ["authorization", '["x-api-key"]', "cookie", '["set-cookie"]'].flatMap((header) =>
  ["headers", "req.headers", "res.headers"].map((parent) => `${parent}${header.startsWith("[") ? "" : "."}${header}`),
);

// The one logger. Fastify writes through it, and the core gets it as its Logger port. Every line written while a
// request is answered carries that request's log context: its ID and, once authenticated, the caller.
export function createLogger(api: ApiSettings): pino.Logger {
  return pino({
    level: api.logLevel,
    redact: { paths: REDACT, censor: "[redacted]" },
    // A copy, because pino merges the line's own fields into what the mixin returns.
    mixin: () => ({ ...logContext.getStore() }),
    ...(api.logPretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" } } }
      : {}),
  });
}
