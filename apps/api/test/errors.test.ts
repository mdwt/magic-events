import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CredentialRateLimitedError } from "../src/core/identity/ports.ts";
import { AppError } from "../src/core/shared/errors.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import { TOOL_FAILED_MESSAGE, toolError } from "../src/mcp/tool.ts";
import { MESSAGES, toErrorReply } from "../src/rest/errors.ts";

// How failures map to what a caller sees, over REST and MCP, with no database.

test("each AppError code maps to its status, with its message and details", () => {
  const cases = [
    ["invalid_input", 400],
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["not_found", 404],
    ["rate_limited", 429],
  ] as const;
  for (const [code, status] of cases) {
    const details = [{ path: "near.lat", message: "Too big." }];
    assert.deepEqual(toErrorReply(new AppError(code, "Told to the caller.", details)), {
      status,
      code,
      message: "Told to the caller.",
      details,
      system: false,
    });
  }
  assert.equal(toErrorReply(new CredentialRateLimitedError("Slow down.", 30)).status, 429);
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

test("Fastify's errors about an unreadable request become invalid_input in our words", () => {
  for (const code of ["FST_ERR_CTP_INVALID_MEDIA_TYPE", "FST_ERR_CTP_BODY_TOO_LARGE", "FST_ERR_CTP_INVALID_JSON_BODY"]) {
    const reply = toErrorReply(Object.assign(new Error("Fastify's own wording"), { code, statusCode: 415 }));
    assert.equal(reply.status, 400);
    assert.equal(reply.code, "invalid_input");
    assert.doesNotMatch(reply.message, /Fastify/);
  }
});

test("anything else is a system error with a general message", () => {
  for (const thrown of [new Error('relation "secret" does not exist'), "a string", null, { statusCode: 400 }]) {
    assert.deepEqual(toErrorReply(thrown), {
      status: 500,
      code: "internal_error",
      message: MESSAGES.internal,
      details: [],
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
