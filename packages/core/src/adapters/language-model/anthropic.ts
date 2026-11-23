import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { BetaContentBlock, BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  type LanguageModel,
  LanguageModelFailed,
  type LanguageModelRequest,
} from "../../shared/language-model.ts";
import type { Logger } from "../../shared/logger.ts";
import type { LanguageModelSettings } from "../../shared/settings.ts";

// The language model port on Claude, through the Anthropic API. This is the only code that imports the SDK.

// The most a Claude Opus 5.5 answer may hold, thinking included. A page can list fifty experiences and a PDF
// calendar a year of them, so the answer is never capped below what the model can give. An answer this long is
// streamed, which the SDK requires for it.
const MAX_TOKENS = 128_000;

// A request the model declines is run again on the model Anthropic recommends for that kind of refusal.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// The text of the answer: what the model that served it wrote. After a fallback, what came before the last
// fallback block is the declined model's partial answer and is not part of it.
function answerText(content: BetaContentBlock[]): string {
  const lastFallback = content.findLastIndex((block) => block.type === "fallback");
  return content
    .slice(lastFallback + 1)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

// A message the API gives when the content is longer than the model's context, which has no error type of its own.
const TOO_LONG = /prompt is too long|too many tokens|context (window|length)|exceeds the maximum|maximum of \d+ PDF pages/i;

// Every failure as the port's one kind, so the caller never reads the provider's errors.
function failureOf(error: unknown, timedOut: boolean): LanguageModelFailed {
  if (error instanceof LanguageModelFailed) return error;
  if (timedOut || error instanceof Anthropic.APIConnectionTimeoutError || error instanceof Anthropic.APIUserAbortError) {
    return new LanguageModelFailed("timed_out", "No answer within the timeout.");
  }
  if (error instanceof Anthropic.ContentTooLargeError) {
    return new LanguageModelFailed("too_long", "The request is larger than the API accepts.");
  }
  if (error instanceof Anthropic.BadRequestError && TOO_LONG.test(error.message)) {
    return new LanguageModelFailed("too_long", error.message);
  }
  if (error instanceof Anthropic.APIError) {
    // Rate limits, overloads, server errors, a refused key and a refused request: the provider turned it away.
    return new LanguageModelFailed(
      "unavailable",
      `${error.status === undefined ? "" : `${String(error.status)} `}${error.message}`,
    );
  }
  return new LanguageModelFailed("unavailable", error instanceof Error ? error.message : String(error));
}

function readAnswer<T>(message: BetaMessage, request: LanguageModelRequest<T>): T {
  // The stop reason comes first: a declined or cut-off answer may not fit the schema at all.
  switch (message.stop_reason) {
    case "refusal":
      throw new LanguageModelFailed(
        "declined",
        `The model declined${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}.`,
      );
    case "max_tokens":
      throw new LanguageModelFailed("cut_off", `The answer reached ${String(MAX_TOKENS)} tokens before it was complete.`);
    case "model_context_window_exceeded":
      throw new LanguageModelFailed("too_long", "The answer ran out of the model's context window.");
    default:
      break;
  }

  let json: unknown;
  try {
    json = JSON.parse(answerText(message.content));
  } catch {
    throw new LanguageModelFailed("wrong_shape", "The answer is not JSON.");
  }
  const parsed = request.schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new LanguageModelFailed("wrong_shape", `The answer does not fit the schema: ${issues}`);
  }
  return parsed.data;
}

export function createLanguageModel(settings: LanguageModelSettings, logger: Logger): LanguageModel {
  const log = logger.child({ adapter: "anthropic" });
  const timeoutMs = settings.timeoutSeconds * 1000;

  // Made on the first call, so a process that never asks, such as the API server, starts without a key.
  let client: Anthropic | undefined;
  function clientOf(): Anthropic {
    if (client) return client;
    if (settings.anthropicApiKey === undefined) {
      throw new LanguageModelFailed("unavailable", "ANTHROPIC_API_KEY is not set.");
    }
    client = new Anthropic({ apiKey: settings.anthropicApiKey, timeout: timeoutMs });
    return client;
  }

  return {
    async ask<T>(request: LanguageModelRequest<T>): Promise<T> {
      const started = performance.now();
      // One deadline for the whole call, the SDK's own retries of overloads and rate limits included.
      const deadline = AbortSignal.timeout(timeoutMs);
      let message: BetaMessage;
      try {
        const { schema } = zodOutputFormat(request.schema);
        const stream = clientOf().beta.messages.stream(
          {
            model: settings.model,
            max_tokens: MAX_TOKENS,
            betas: [FALLBACK_BETA],
            fallbacks: "default",
            // The format without its parser: the answer is read only after the stop reason is checked.
            output_config: { effort: settings.anthropicEffort, format: { type: "json_schema", schema } },
            // The instructions are the same for every call of one kind, so they are read from the cache.
            system: [{ type: "text", text: request.instructions, cache_control: { type: "ephemeral" } }],
            messages: [
              {
                role: "user",
                content: [
                  ...(request.document
                    ? [
                        {
                          type: "document" as const,
                          source: {
                            type: "base64" as const,
                            media_type: "application/pdf" as const,
                            data: request.document.base64,
                          },
                        },
                      ]
                    : []),
                  { type: "text" as const, text: request.text },
                ],
              },
            ],
          },
          { signal: deadline },
        );
        message = await stream.finalMessage();
      } catch (error) {
        const failure = failureOf(error, deadline.aborted);
        log.debug(
          { model: settings.model, milliseconds: Math.round(performance.now() - started), reason: failure.reason },
          "Language model call failed",
        );
        throw failure;
      }

      const usage = message.usage;
      log.debug(
        {
          model: message.model,
          milliseconds: Math.round(performance.now() - started),
          stopReason: message.stop_reason,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
        },
        "Language model answered",
      );
      return readAnswer(message, request);
    },
  };
}
