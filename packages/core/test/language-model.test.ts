import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { z } from "zod";
import { createLanguageModel } from "../src/adapters/language-model/anthropic.ts";
import { LanguageModelFailed, type LanguageModelFailure } from "../src/shared/language-model.ts";
import type { Logger } from "../src/shared/logger.ts";
import type { LanguageModelSettings } from "../src/shared/settings.ts";

// The Anthropic adapter against a local server that answers as the Messages API does, so no real call is made.

type Handler = (body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let handle: Handler;
let received: { body: Record<string, unknown>; headers: IncomingMessage["headers"] }[] = [];
const debug: { context: Record<string, unknown>; message: string }[] = [];

const logger: Logger = {
  debug: (context, message) => debug.push({ context: context as Record<string, unknown>, message }),
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const settings: LanguageModelSettings = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  timeoutSeconds: 1,
  anthropicApiKey: "test-key",
  anthropicEffort: "medium",
};

const schema = z.object({ city: z.string(), letters: z.number() });

function event(response: ServerResponse, type: string, data: Record<string, unknown>): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

// A streamed answer of these content blocks, ending with the stop reason.
function stream(blocks: Record<string, unknown>[], stopReason = "end_turn"): Handler {
  return (_body, _request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    event(response, "message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    });
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        event(response, "content_block_start", { index, content_block: { type: "text", text: "" } });
        event(response, "content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
      } else {
        event(response, "content_block_start", { index, content_block: block });
      }
      event(response, "content_block_stop", { index });
    });
    event(response, "message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } });
    event(response, "message_stop", {});
    response.end();
  };
}

function text(value: string) {
  return { type: "text", text: value };
}

function error(status: number, type: string, message: string): Handler {
  return (_body, _request, response) => {
    // Tells the SDK not to retry, so a test does not wait for its backoff.
    response.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
    response.end(JSON.stringify({ type: "error", error: { type, message } }));
  };
}

function failsWith(reason: LanguageModelFailure) {
  return (thrown: unknown) => thrown instanceof LanguageModelFailed && thrown.reason === reason;
}

before(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ body, headers: request.headers });
      handle(body, request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
  debug.length = 0;
  handle = stream([text('{"city":"Cape Town","letters":9}')]);
});

describe("The Anthropic adapter", () => {
  test("answers in the schema's shape, and sends the request the doc describes", async () => {
    const model = createLanguageModel(settings, logger);
    const answer = await model.ask({
      instructions: "Answer in the shape asked.",
      text: "Which city?",
      document: { mediaType: "application/pdf", base64: "JVBERi0xLjQK" },
      schema,
    });
    assert.deepEqual(answer, { city: "Cape Town", letters: 9 });

    const [{ body, headers }] = received as [(typeof received)[number]];
    assert.equal(headers.authorization, "Bearer test-key");
    assert.match(String(headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.max_tokens, 128_000);
    assert.equal(body.stream, true);
    assert.equal(body.fallbacks, "default");
    assert.equal(body.thinking, undefined);
    assert.deepEqual(body.system, [
      { type: "text", text: "Answer in the shape asked.", cache_control: { type: "ephemeral" } },
    ]);
    assert.deepEqual(body.messages, [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } },
          { type: "text", text: "Which city?" },
        ],
      },
    ]);
    const outputConfig = body.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    assert.equal(outputConfig.effort, "medium");
    assert.equal(outputConfig.format.type, "json_schema");
    assert.deepEqual(outputConfig.format.schema.required, ["city", "letters"]);
    assert.equal(outputConfig.format.schema.additionalProperties, false);
  });

  test("logs each call at debug with the model, the time and the tokens, and never the content", async () => {
    await createLanguageModel(settings, logger).ask({ instructions: "Secret instructions", text: "Secret text", schema });
    const [line] = debug;
    assert.equal(line?.message, "Language model answered");
    assert.equal(line.context.model, "claude-opus-5-5");
    assert.equal(line.context.inputTokens, 120);
    assert.equal(line.context.outputTokens, 42);
    assert.equal(line.context.cacheReadTokens, 100);
    assert.equal(typeof line.context.milliseconds, "number");
    assert.doesNotMatch(JSON.stringify(debug), /Secret|Cape Town/);
  });

  test("after a fallback, the answer is what the fallback model wrote", async () => {
    handle = stream([
      text('{"city":'),
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } },
      text('{"city":"Cape Town","letters":9}'),
    ]);
    const answer = await createLanguageModel(settings, logger).ask({ instructions: "i", text: "t", schema });
    assert.deepEqual(answer, { city: "Cape Town", letters: 9 });
  });

  test("a refusal is declined and running out of tokens is cut off, whatever the text", async () => {
    const model = createLanguageModel(settings, logger);
    handle = stream([text('{"city":"Cape Town","letters":9}')], "refusal");
    await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("declined"));
    handle = stream([text('{"city":"Cape')], "max_tokens");
    await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("cut_off"));
  });

  test("an answer that is not JSON, or does not fit the schema, has the wrong shape", async () => {
    const model = createLanguageModel(settings, logger);
    handle = stream([text("Cape Town")]);
    await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("wrong_shape"));
    handle = stream([text('{"city":"Cape Town","letters":"nine"}')]);
    await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("wrong_shape"));
  });

  test("content too long for the model is too long", async () => {
    const model = createLanguageModel(settings, logger);
    handle = error(400, "invalid_request_error", "prompt is too long: 1200000 tokens > 1000000 maximum");
    await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("too_long"));
    handle = error(413, "request_too_large", "Request exceeds the maximum allowed number of bytes.");
    await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("too_long"));
  });

  test("rate limits, overloads, a refused key and other refused requests are unavailable", async () => {
    const model = createLanguageModel(settings, logger);
    for (const [status, type] of [
      [429, "rate_limit_error"],
      [529, "overloaded_error"],
      [500, "api_error"],
      [401, "authentication_error"],
      [400, "invalid_request_error"],
    ] as const) {
      handle = error(status, type, "No.");
      await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("unavailable"));
    }
  });

  test("no answer within the timeout is timed out", async () => {
    handle = () => {
      // Never answers.
    };
    await assert.rejects(
      createLanguageModel(settings, logger).ask({ instructions: "i", text: "t", schema }),
      failsWith("timed_out"),
    );
  });

  test("without a key it is unavailable, and the API is not called; the adapter is made without one", async () => {
    const model = createLanguageModel({ ...settings, anthropicApiKey: undefined }, logger);
    await assert.rejects(model.ask({ instructions: "i", text: "t", schema }), failsWith("unavailable"));
    assert.equal(received.length, 0);
  });

  test("a provider that cannot be reached is unavailable", async () => {
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
    try {
      await assert.rejects(
        createLanguageModel(settings, logger).ask({ instructions: "i", text: "t", schema }),
        (thrown) => thrown instanceof LanguageModelFailed && ["unavailable", "timed_out"].includes(thrown.reason),
      );
    } finally {
      process.env.ANTHROPIC_BASE_URL = previous;
    }
  });
});
