import { errorOf, type Call } from "./api.ts";
import type { Checks } from "./checks.ts";
import { LEVEL, until, type ApiServer, type LogLine } from "./server.ts";

// What the server's log must show for each request: a line when it starts (debug) and one when it completes (info),
// with the same request ID the client got back; after authentication, who is calling on every line; a refusal at
// warn with its reason; a system error at error with the error itself.

const COMPLETED = new Set(["Request completed", "Request failed while sending the answer"]);
const CALLER_FIELDS = ["tenantId", "userId", "callerKind", "role", "credentialId"] as const;

export function linesOf(server: ApiServer, requestId: string): LogLine[] {
  return server.lines().filter((line) => line.requestId === requestId);
}

export function describeLine(line: LogLine): string {
  return `${String(line.level)} "${String(line.msg)}"`;
}

// Waits until the server has written the closing line of each call: it is written once the answer is sent.
export async function waitForClosingLines(list: Call[]): Promise<void> {
  const pending = list.filter((call) => call.requestId !== null && call.server.running);
  try {
    await until(
      "the closing line of every request",
      () => {
        const missing = pending.filter((call) =>
          call.server.find((line) => line.requestId === call.requestId && COMPLETED.has(String(line.msg))) === undefined,
        );
        return missing.length === 0 ? true : undefined;
      },
      5_000,
      100,
    );
  } catch {
    // Reported by checkCallLogs, request by request.
  }
}

// Whether the request got as far as knowing who is calling: a key the run holds, past authentication.
function authenticated(call: Call): boolean {
  if (call.credential !== "client" || call.client === undefined) return false;
  if (call.path.split("?")[0] === "/health") return false;
  return ![401, 429, 503].includes(call.status);
}

export function checkCallLogs(call: Call, c: Checks): void {
  const label = `${call.method} ${call.path} → ${call.status}`;
  if (call.requestId === null) {
    c.fail(`${label}: no x-request-id header`);
    return;
  }
  const body = errorOf(call.json);
  if (body !== undefined && body.requestId !== call.requestId) {
    c.fail(`${label}: requestId in the body (${body.requestId}) is not the x-request-id (${call.requestId})`);
  }

  const lines = linesOf(call.server, call.requestId);
  const started = lines.findIndex((line) => line.msg === "Request started");
  const completedAt = lines.findIndex((line) => COMPLETED.has(String(line.msg)));
  const startLine = lines[started];
  const completed = lines[completedAt];
  if (startLine === undefined) c.fail(`${label}: no "Request started" line for ${call.requestId}`);
  else {
    c.ok(startLine.level === LEVEL.debug, `${label}: "Request started" is not at debug`);
    c.ok(startLine.method === call.method && startLine.url === call.path, `${label}: "Request started" lacks the method or address`);
  }
  if (completed === undefined) {
    c.fail(`${label}: no "Request completed" line for ${call.requestId}`);
    return;
  }
  c.ok(completed.level === LEVEL.info, `${label}: "Request completed" is not at info`);
  c.ok(completed.method === call.method, `${label}: the closing line lacks the method`);
  c.ok(completed.url === call.path, `${label}: the closing line lacks the address`);
  c.ok(completed.statusCode === call.status, `${label}: the closing line has status ${String(completed.statusCode)}`);
  c.ok(typeof completed.durationMs === "number", `${label}: the closing line has no durationMs`);
  if (started > completedAt) c.fail(`${label}: "Request completed" comes before "Request started"`);

  if (authenticated(call) && call.client !== undefined) {
    const expected = {
      tenantId: call.client.tenantId,
      userId: call.client.userId,
      callerKind: call.client.kind,
      role: call.client.role,
      credentialId: call.client.credentialId,
    };
    for (const field of CALLER_FIELDS) {
      if (completed[field] !== expected[field]) {
        c.fail(`${label}: the closing line has ${field} ${JSON.stringify(completed[field])}, not ${JSON.stringify(expected[field])}`);
      }
    }
    // Every line after authentication carries who is calling.
    const after = lines.filter((line, index) => index !== started && line.msg !== "Authentication refused");
    const without = after.filter((line) => line.userId !== call.client?.userId);
    if (without.length > 0) c.fail(`${label}: lines without the caller: ${without.map(describeLine).join(", ")}`);
  }

  if (call.status >= 400 && call.status < 500) {
    const refusal = lines.find((line) => line.level === LEVEL.warn && typeof line.reason === "string" && line.reason !== "");
    c.ok(refusal !== undefined, `${label}: no warn line with the reason for the refusal`);
    if (body !== undefined && body.details.length > 0) {
      const logged = lines.find((line) => line.level === LEVEL.warn && Array.isArray(line.details));
      const paths = (logged?.details as { path?: string }[] | undefined)?.map((detail) => detail.path) ?? [];
      for (const detail of body.details) {
        if (!paths.includes(detail.path)) c.fail(`${label}: the refusal's log line does not name the field "${detail.path}"`);
      }
    }
  }
  if (call.status >= 500) {
    const failure = lines.find((line) => (line.level ?? 0) >= LEVEL.error && line.err !== undefined);
    c.ok(failure !== undefined, `${label}: no error line with the error itself`);
  }
}

// Every key the run used and every "Bearer " must be absent from a log.
export function secretsIn(text: string, keys: string[]): string[] {
  const found: string[] = [];
  for (const key of keys) if (text.includes(key)) found.push(`${key.slice(0, 8)}…`);
  if (/Bearer /.test(text)) found.push("Bearer ");
  return found;
}
