import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CredentialRateLimitedError } from "@magic-events/core/identity/ports.ts";
import { isDatabaseUnavailable } from "@magic-events/core/adapters/storage/unavailable.ts";
import { AppError, UNAVAILABLE_RETRY_AFTER_SECONDS, unavailable } from "@magic-events/core/shared/errors.ts";
import type { Logger } from "@magic-events/core/shared/logger.ts";
import { TOOL_FAILED_MESSAGE, toolError } from "../src/mcp/tool.ts";
import { MESSAGES, toErrorReply } from "../src/rest/errors.ts";

// How failures map to what a caller sees, over REST and MCP, with no database.

test("each AppError code maps to its status, with its message and details", () => {
  const cases = [
    ["invalid_input", 400],
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["not_found", 404],
    ["conflict", 409],
    ["content_too_large", 413],
    ["unsupported_media_type", 415],
    ["rate_limited", 429],
    ["unavailable", 503],
  ] as const;
  for (const [code, status] of cases) {
    const details = [{ path: "near.lat", message: "Too big." }];
    assert.deepEqual(toErrorReply(new AppError(code, "Told to the caller.", details)), {
      status,
      code,
      message: "Told to the caller.",
      details,
      retryAfterSeconds: undefined,
      system: code === "unavailable",
    });
  }
  const limited = toErrorReply(new CredentialRateLimitedError("Slow down.", 30));
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfterSeconds, 30);
});

test("a database that cannot be reached is unavailable with Retry-After, and anything else stays internal_error", () => {
  const outage = Object.assign(new Error("Failed query: select 1"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
  });
  const reply = toErrorReply(outage, isDatabaseUnavailable);
  assert.equal(reply.status, 503);
  assert.equal(reply.code, "unavailable");
  assert.equal(reply.retryAfterSeconds, UNAVAILABLE_RETRY_AFTER_SECONDS);
  assert.equal(reply.system, true);
  assert.doesNotMatch(reply.message, /ECONNREFUSED|5432|query/);

  for (const code of ["CONNECTION_ENDED", "57P01", "08006"]) {
    assert.equal(toErrorReply(Object.assign(new Error("x"), { code }), isDatabaseUnavailable).status, 503, code);
  }
  const missingTable = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("x"), { code: "42P01" }) });
  assert.equal(toErrorReply(missingTable, isDatabaseUnavailable).status, 500);
  assert.equal(toErrorReply(unavailable(new Error("down"))).status, 503);
});

test("a Zod validation failure is invalid_input with one readable detail per problem", async () => {
  // The validation error as Fastify raises it, from the Zod validator the server uses.
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  let caught: unknown;
  app.setErrorHandler((error, _request, reply) => {
    caught = error;
    return reply.code(400).send();
  });
  app.post("/", { schema: { body: z.strictObject({ near: z.object({ lat: z.number().max(90) }) }) } }, () => "");
  await app.inject({ method: "POST", url: "/", payload: { near: { lat: 200 }, colour: "blue", size: 1 } });
  await app.close();

  const reply = toErrorReply(caught);
  assert.equal(reply.status, 400);
  assert.equal(reply.code, "invalid_input");
  assert.equal(reply.message, MESSAGES.invalidInput);
  assert.deepEqual(
    reply.details.map((detail) => detail.path).sort(),
    ["colour", "near.lat", "size"],
  );
});

test("Fastify's errors about an unreadable request get their own status, in our words", () => {
  for (const [code, statusCode, status, answer] of [
    ["FST_ERR_CTP_INVALID_MEDIA_TYPE", 415, 415, "unsupported_media_type"],
    ["FST_ERR_CTP_BODY_TOO_LARGE", 413, 413, "content_too_large"],
    ["FST_ERR_CTP_INVALID_JSON_BODY", 400, 400, "invalid_input"],
    // One we do not list, raised with a 4xx status: the request could not be read.
    ["FST_ERR_SOMETHING_NEW", 400, 400, "invalid_input"],
  ] as const) {
    const reply = toErrorReply(Object.assign(new Error("Fastify's own wording"), { code, statusCode }));
    assert.equal(reply.status, status, code);
    assert.equal(reply.code, answer, code);
    assert.equal(reply.system, false, code);
    assert.doesNotMatch(reply.message, /Fastify/);
  }
  // Another library's error that carries a 4xx status is still a system error: the request was not at fault.
  assert.equal(toErrorReply(Object.assign(new Error("Bad request"), { statusCode: 400, code: "BAD_REQUEST" })).status, 500);
});

test("anything else is a system error with a general message", () => {
  for (const thrown of [new Error('relation "secret" does not exist'), "a string", null, { statusCode: 400 }]) {
    assert.deepEqual(toErrorReply(thrown), {
      status: 500,
      code: "internal_error",
      message: MESSAGES.internal,
      details: [],
      retryAfterSeconds: undefined,
      system: true,
    });
  }
});

test("over MCP, an AppError is a tool error with its message, and anything else is logged and general", () => {
  const logged: { level: string; context: object }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (context) => logged.push({ level: "warn", context }),
    error: (context) => logged.push({ level: "error", context }),
    child: () => logger,
  };

  const refused = toolError(new AppError("forbidden", "You may not do this."), "search_experiences", logger);
  assert.equal(refused.isError, true);
  assert.deepEqual(JSON.parse(refused.content[0]?.type === "text" ? refused.content[0].text : ""), {
    error: { code: "forbidden", message: "You may not do this.", details: [] },
  });

  const failed = toolError(new Error("connection to postgres lost"), "search_experiences", logger);
  assert.equal(failed.isError, true);
  const text = failed.content[0]?.type === "text" ? failed.content[0].text : "";
  assert.doesNotMatch(text, /postgres/);
  assert.match(text, new RegExp(TOOL_FAILED_MESSAGE.slice(0, 20)));
  assert.deepEqual(
    logged.map((line) => line.level),
    ["warn", "error"],
  );
});
