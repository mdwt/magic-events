import assert from "node:assert/strict";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { createEmbeddingModel } from "../src/adapters/embedding/bedrock.ts";
import { EmbeddingFailed } from "../src/core/catalogue/ports.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import type { EmbeddingSettings } from "../src/core/shared/settings.ts";
import { point } from "./helpers/fake-embedding-model.ts";

// The Bedrock adapter against a local server that stands in for Bedrock. The AWS SDK is pointed at it through its
// own endpoint setting, with made-up credentials, so nothing reaches AWS. The Bedrock Runtime client speaks HTTP/2,
// so the stand-in is a cleartext HTTP/2 server.

interface Received {
  method: string | undefined;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  delayMs?: number;
}

const settings: EmbeddingSettings = {
  provider: "bedrock",
  model: "amazon.titan-embed-text-v2:0",
  batchSize: 100,
  queryTimeoutSeconds: 5,
  awsRegion: "us-east-1",
};

const received: Received[] = [];
let answer: (request: Received) => Answer = () => ({ body: "{}" });
let inFlight = 0;
let mostInFlight = 0;
let server: Http2Server;

function embedding(coordinates: number[]): string {
  return JSON.stringify({ embedding: point(coordinates), inputTextTokenCount: 3 });
}

function awsError(status: number, type: string, message: string): Answer {
  return { status, headers: { "x-amzn-errortype": type }, body: JSON.stringify({ message }) };
}

function logger() {
  const lines: { context: object; message: string }[] = [];
  const log: Logger = {
    debug: (context, message) => lines.push({ context, message }),
    info: (context, message) => lines.push({ context, message }),
    warn: (context, message) => lines.push({ context, message }),
    error: (context, message) => lines.push({ context, message }),
    child: () => log,
  };
  return { log, lines };
}

async function failure(promise: Promise<unknown>): Promise<EmbeddingFailed> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EmbeddingFailed, `expected EmbeddingFailed, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const one: Received = {
        method: request.method,
        path: decodeURIComponent(request.url),
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      received.push(one);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      const reply = answer(one);
      setTimeout(() => {
        inFlight -= 1;
        response.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        response.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = `http://127.0.0.1:${String(port)}`;
  process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  process.env.AWS_MAX_ATTEMPTS = "1";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

beforeEach(() => {
  received.length = 0;
  mostInFlight = 0;
  answer = () => ({ body: embedding([1]) });
});

describe("the Bedrock adapter", () => {
  test("names the model and its 1024 dimensions", () => {
    const model = createEmbeddingModel(settings, logger().log);
    assert.equal(model.model, "amazon.titan-embed-text-v2:0");
    assert.equal(model.dimensions, 1024);
  });

  test("sends one text per InvokeModel request, asking for 1024 normalised dimensions", async () => {
    const model = createEmbeddingModel(settings, logger().log);
    const [vector] = await model.embed(["Whale Festival\nA festival on the cliffs."], "document");

    assert.deepEqual(vector, point([1]));
    assert.equal(received.length, 1);
    const [request] = received;
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/model/amazon.titan-embed-text-v2:0/invoke");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.accept, "application/json");
    assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/bedrock\//);
    assert.deepEqual(request.body, { inputText: "Whale Festival\nA festival on the cliffs.", dimensions: 1024, normalize: true });
  });

  test("embeds a query the same way: the purpose is not sent", async () => {
    const model = createEmbeddingModel(settings, logger().log);
    await model.embed(["romantic and quiet"], "query");
    assert.deepEqual(received[0]?.body, { inputText: "romantic and quiet", dimensions: 1024, normalize: true });
  });

  test("returns the embeddings in the order of the texts, sending a few at a time", async () => {
    const texts = Array.from({ length: 10 }, (_, index) => `text ${String(index)}`);
    // Later texts are answered sooner, so the answers arrive out of order.
    answer = (request) => {
      const index = texts.indexOf(String(request.body.inputText));
      return { body: embedding([0, index + 1]), delayMs: (texts.length - index) * 5 };
    };
    const model = createEmbeddingModel(settings, logger().log);
    const vectors = await model.embed(texts, "document");

    assert.deepEqual(
      vectors,
      texts.map((_, index) => point([0, index + 1])),
    );
    assert.equal(received.length, 10);
    assert.ok(mostInFlight > 1 && mostInFlight <= 4, `at most four at a time, saw ${String(mostInFlight)}`);
  });

  test("an empty list is answered with no request", async () => {
    const model = createEmbeddingModel(settings, logger().log);
    assert.deepEqual(await model.embed([], "document"), []);
    assert.equal(received.length, 0);
  });

  test("a text too long for the model is sent whole, and its refusal is a failure", async () => {
    const long = "whales ".repeat(10_000);
    answer = () => awsError(400, "ValidationException", "400 Bad Request: Too many input tokens.");
    const model = createEmbeddingModel(settings, logger().log);
    const error = await failure(model.embed([long], "document"));

    assert.match(error.message, /ValidationException: 400 Bad Request: Too many input tokens/);
    assert.equal(received[0]?.body.inputText, long);
  });

  test("every error Bedrock answers with is an EmbeddingFailed", async () => {
    const cases: [Answer, RegExp][] = [
      [awsError(403, "AccessDeniedException", "You don't have access to the model."), /403 AccessDeniedException/],
      [awsError(404, "ResourceNotFoundException", "Model not found."), /404 ResourceNotFoundException/],
      [awsError(429, "ThrottlingException", "Too many requests."), /429 ThrottlingException/],
      [awsError(500, "InternalServerException", "Something went wrong."), /500 InternalServerException/],
      [{ body: "not json" }, /not JSON|SyntaxError/],
      [{ body: JSON.stringify({ embedding: [0.1, 0.2] }) }, /no embedding of 1024 numbers/],
      [{ body: JSON.stringify({ inputTextTokenCount: 3 }) }, /no embedding of 1024 numbers/],
    ];
    for (const [reply, message] of cases) {
      answer = () => reply;
      const model = createEmbeddingModel(settings, logger().log);
      const error = await failure(model.embed(["one"], "document"));
      assert.match(error.message, message);
    }
  });

  test("one failing text fails the call, and no further text is sent after it", async () => {
    const texts = Array.from({ length: 20 }, (_, index) => `text ${String(index)}`);
    answer = (request) =>
      request.body.inputText === "text 0" ? awsError(500, "InternalServerException", "boom") : { body: embedding([1]), delayMs: 20 };
    const model = createEmbeddingModel(settings, logger().log);
    await failure(model.embed(texts, "document"));
    assert.ok(received.length < texts.length, `sent ${String(received.length)} of ${String(texts.length)}`);
  });

  test("an unreachable endpoint is an EmbeddingFailed", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve();
      });
    });
    const endpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = `http://127.0.0.1:${String(port)}`;
    try {
      const model = createEmbeddingModel(settings, logger().log);
      await failure(model.embed(["one"], "document"));
    } finally {
      process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = endpoint;
    }
  });

  test("with no region it fails without a request, and is made only on the first call", async () => {
    const model = createEmbeddingModel({ ...settings, awsRegion: undefined }, logger().log);
    const error = await failure(model.embed(["one"], "document"));
    assert.match(error.message, /AWS_REGION is not set/);
    assert.equal(received.length, 0);
  });

  test("logs each call at debug with the model, the count and the time, never the text", async () => {
    const { log, lines } = logger();
    const model = createEmbeddingModel(settings, log);
    await model.embed(["a secret plan for the trip"], "document");
    answer = () => awsError(500, "InternalServerException", "boom");
    await failure(model.embed(["another secret plan"], "document"));

    assert.deepEqual(
      lines.map((line) => line.message),
      ["Embedded texts", "Embedding failed"],
    );
    for (const line of lines) {
      assert.equal((line.context as { model?: string }).model, "amazon.titan-embed-text-v2:0");
      assert.equal((line.context as { count?: number }).count, 1);
      assert.equal(typeof (line.context as { milliseconds?: number }).milliseconds, "number");
      assert.doesNotMatch(JSON.stringify(line.context), /secret plan/);
    }
  });
});
