import { AsyncLocalStorage } from "node:async_hooks";

// The fields every log line written while answering one request carries: its request ID and, once the caller is
// authenticated, who is calling. The inbound side opens it for each request, and the logger adds it to every line,
// including the lines the core services write. It belongs to no domain.
export const logContext = new AsyncLocalStorage<Record<string, unknown>>();
