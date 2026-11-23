// Whether an error says the database cannot be reached, as opposed to a query that failed. Drizzle wraps the driver's
// error in its own, so the causes are followed too. app.ts hands this to the inbound sides, which answer such a failure
// with unavailable and Retry-After instead of internal_error.

// postgres.js's own codes for a connection it lost or could not open, and the socket's.
const CONNECTION_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
]);

// PostgreSQL's SQLSTATEs for a server that is shutting down, starting up or full. Class 08 is a connection exception.
const SERVER_CODES = new Set(["57P01", "57P02", "57P03", "53300"]);

export function isDatabaseUnavailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && (CONNECTION_CODES.has(code) || SERVER_CODES.has(code) || code.startsWith("08"))) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
