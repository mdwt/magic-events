import {
  BedrockRuntimeClient,
  BedrockRuntimeServiceException,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { EmbeddingFailed, type EmbeddingModel } from "../../core/catalogue/ports.ts";
import type { Logger } from "../../core/shared/logger.ts";
import type { EmbeddingSettings } from "../../core/shared/settings.ts";

// The embedding model port on Amazon Titan Text Embeddings V2, through Amazon Bedrock. This is the only code that
// imports the AWS SDK.

// The size of the experience's embedding column.
const DIMENSIONS = 1024;
// Titan takes one text per request, so a round's texts are sent this many at a time.
const CONCURRENCY = 4;

const responseSchema = z.object({ embedding: z.array(z.number()).length(DIMENSIONS) });

// Every failure as the port's one kind, so the caller never reads the provider's errors.
function failureOf(error: unknown): EmbeddingFailed {
  if (error instanceof EmbeddingFailed) return error;
  if (error instanceof BedrockRuntimeServiceException) {
    const status = error.$metadata.httpStatusCode;
    return new EmbeddingFailed(`${status === undefined ? "" : `${String(status)} `}${error.name}: ${error.message}`);
  }
  return new EmbeddingFailed(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

function readEmbedding(body: Uint8Array): number[] {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new EmbeddingFailed("The answer is not JSON.");
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new EmbeddingFailed(`The answer has no embedding of ${String(DIMENSIONS)} numbers.`);
  return parsed.data.embedding;
}

export function createEmbeddingModel(settings: EmbeddingSettings, logger: Logger): EmbeddingModel {
  const log = logger.child({ adapter: "bedrock" });

  // Made on the first call, so a process that never embeds starts without AWS credentials or a region.
  let client: BedrockRuntimeClient | undefined;
  function clientOf(): BedrockRuntimeClient {
    if (client) return client;
    if (settings.awsRegion === undefined) throw new EmbeddingFailed("AWS_REGION is not set.");
    // The credentials come from the SDK's default chain: access keys, a profile or a role.
    client = new BedrockRuntimeClient({ region: settings.awsRegion });
    return client;
  }

  async function embedOne(text: string): Promise<number[]> {
    let body: Uint8Array;
    try {
      const response = await clientOf().send(
        new InvokeModelCommand({
          modelId: settings.model,
          contentType: "application/json",
          accept: "application/json",
          // The whole text: one too long for the model fails, and is never cut.
          body: JSON.stringify({ inputText: text, dimensions: DIMENSIONS, normalize: true }),
        }),
      );
      body = response.body;
    } catch (error) {
      throw failureOf(error);
    }
    return readEmbedding(body);
  }

  return {
    model: settings.model,
    dimensions: DIMENSIONS,

    // Titan embeds documents and queries the same way, so the purpose is not sent.
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const started = performance.now();
      const embeddings: number[][] = new Array<number[]>(texts.length);
      let next = 0;
      let failed = false;

      // Each worker takes the next text until none is left. After a failure none takes another.
      async function worker(): Promise<void> {
        while (!failed && next < texts.length) {
          const index = next;
          next += 1;
          try {
            embeddings[index] = await embedOne(texts[index] ?? "");
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }

      try {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
      } catch (error) {
        const failure = failureOf(error);
        log.debug(
          {
            model: settings.model,
            count: texts.length,
            milliseconds: Math.round(performance.now() - started),
            error: failure.message,
          },
          "Embedding failed",
        );
        throw failure;
      }
      log.debug(
        { model: settings.model, count: texts.length, milliseconds: Math.round(performance.now() - started) },
        "Embedded texts",
      );
      return embeddings;
    },
  };
}
