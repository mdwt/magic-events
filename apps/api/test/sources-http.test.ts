import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createSourceFetchers } from "../src/adapters/sources/index.ts";
import { createHttp, HttpStatusError, textOf } from "../src/adapters/sources/http.ts";
import type { LanguageModel } from "../src/core/shared/language-model.ts";
import type { Logger } from "../src/core/shared/logger.ts";
import type { DiscoverySettings } from "../src/core/shared/settings.ts";
import { startFixtureServer, type FixtureServer } from "./fixtures/sources/server.ts";

// What every source adapter's requests share: the User-Agent, the timeout, the size cap and compressed answers.

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

let server: FixtureServer;

before(async () => {
  server = await startFixtureServer();
  server.route("/compressed", { body: "<p>Unpacked</p>".repeat(1000), gzip: true });
  server.route("/slow", { body: "late", delayMs: 1500 });
  server.route("/large", { body: "x".repeat(2048) });
  server.route("/latin1", { type: "text/html; charset=iso-8859-1", body: Buffer.from([0x63, 0x61, 0x66, 0xe9]) });
  server.route("/teapot", { status: 418, body: "short and stout" });
});

after(async () => {
  await server.close();
});

describe("source adapters' HTTP", () => {
  const http = createHttp({ timeoutSeconds: 1, userAgent: "Mozilla/5.0 (compatible; magic-events/1.0)" });

  test("sends the configured User-Agent and unpacks a compressed answer", async () => {
    const response = await http.get(server.url("/compressed"), { accept: "text/html", maxBytes: 1024 * 1024 });

    assert.equal(textOf(response), "<p>Unpacked</p>".repeat(1000));
    const request = server.requests.at(-1);
    assert.equal(request?.headers["user-agent"], "Mozilla/5.0 (compatible; magic-events/1.0)");
    assert.equal(request.headers.accept, "text/html");
  });

  test("gives up after the timeout", async () => {
    await assert.rejects(http.get(server.url("/slow"), { accept: "*/*", maxBytes: 1024 }), /timed out after 1 s/);
  });

  test("refuses an answer larger than the cap", async () => {
    await assert.rejects(http.get(server.url("/large"), { accept: "*/*", maxBytes: 1024 }), /more than/);
  });

  test("decodes the character set the answer names", async () => {
    const response = await http.get(server.url("/latin1"), { accept: "*/*", maxBytes: 1024 });
    assert.equal(textOf(response), "café");
  });

  test("a status other than 2xx is an HttpStatusError with the status", async () => {
    await assert.rejects(
      http.get(server.url("/teapot"), { accept: "*/*", maxBytes: 1024 }),
      (error) => error instanceof HttpStatusError && error.status === 418 && /answered 418/.test(error.message),
    );
  });

  test("an address nothing answers at fails with why", async () => {
    await assert.rejects(http.get("http://127.0.0.1:1/", { accept: "*/*", maxBytes: 1024 }), /GET http:\/\/127\.0\.0\.1:1\/ failed/);
  });
});

describe("createSourceFetchers", () => {
  test("gives an adapter for each kind that needs no API key", () => {
    const settings: DiscoverySettings = {
      defaultFetchIntervalHours: 168,
      defaultMissedRunsBeforeRemoval: 3,
      defaultMaxProcessingAttempts: 3,
      scheduleIntervalSeconds: 60,
      fetchTimeoutSeconds: 30,
      userAgent: "test",
      horizonMonths: 24,
      credentials: {},
    };
    const languageModel: LanguageModel = { ask: () => Promise.reject(new Error("not used")) };
    const fetchers = createSourceFetchers({ languageModel, settings, logger: silent });
    assert.deepEqual(fetchers.map((fetcher) => fetcher.kind).sort(), ["pdf_calendar", "rss_feed", "web_page"]);
  });
});
