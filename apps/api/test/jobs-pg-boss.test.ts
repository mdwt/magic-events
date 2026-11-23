import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createDb } from "@magic-events/db";
import { ensureDatabase } from "@magic-events/db/migrate";
import { sql } from "drizzle-orm";
import { createJobQueue } from "../src/adapters/jobs/pg-boss.ts";
import type { JobHandler, JobName, JobPolicy, JobQueue, Jobs, RunningJob } from "../src/core/shared/jobs.ts";
import type { Logger } from "../src/core/shared/logger.ts";

// The pg-boss job queue against Postgres. Each test has a pg-boss schema of its own, dropped at the end.

const url = process.env.TEST_DATABASE_URL ?? "";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

const policy: JobPolicy = { retries: 0, retryDelaySeconds: 1, retryBackoff: false, timeoutSeconds: 60, concurrency: 1 };

let database: ReturnType<typeof createDb>;
const schemas: string[] = [];
const queues: JobQueue[] = [];

function newQueue(logger: Logger = silent): { queue: JobQueue; schema: string } {
  const schema = `pgboss_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  schemas.push(schema);
  const queue = createJobQueue({ databaseUrl: url, logger, schema, pollingIntervalSeconds: 0.5 });
  queues.push(queue);
  return { queue, schema };
}

function handler<N extends JobName>(
  name: N,
  run: (payload: Jobs[N], job: RunningJob) => Promise<void>,
  overrides: Partial<JobPolicy> = {},
): JobHandler<N> {
  return { name, policy: { ...policy, ...overrides }, run };
}

// Resolves when the condition holds, or rejects at the deadline.
async function until(condition: () => boolean | Promise<boolean>, seconds = 10): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function jobRows(schema: string, name: JobName): Promise<{ state: string; singleton_key: string | null }[]> {
  return database.db.execute<{ state: string; singleton_key: string | null }>(
    sql`select state, singleton_key from ${sql.identifier(schema)}.job where name = ${name} order by created_on`,
  );
}

before(async () => {
  if (url === "") throw new Error("Set TEST_DATABASE_URL to run the database tests.");
  await ensureDatabase(url);
  database = createDb(url, { max: 2 });
});

after(async () => {
  for (const queue of queues) await queue.stop();
  for (const schema of schemas) await database.db.execute(sql`drop schema if exists ${sql.identifier(schema)} cascade`);
  await database.close();
});

describe("pg-boss job queue", () => {
  test("a registered handler receives an enqueued job with its payload", async () => {
    const { queue } = newQueue();
    const received: { payload: Jobs["discovery.fetch-source"]; attempt: number }[] = [];
    queue.register(
      handler("discovery.fetch-source", (payload, job) => {
        received.push({ payload, attempt: job.attempt });
        return Promise.resolve();
      }),
    );
    await queue.start();
    await queue.enqueue("discovery.fetch-source", { sourceId: "source-1" }, { key: "source-1" });

    await until(() => received.length === 1);
    assert.deepEqual(received, [{ payload: { sourceId: "source-1" }, attempt: 1 }]);
    await queue.stop();
  });

  test("a handler that throws is tried again after the retry delay, and then succeeds", async () => {
    const { queue, schema } = newQueue();
    const attempts: { attempt: number; at: number }[] = [];
    queue.register(
      handler(
        "discovery.fetch-source",
        (_payload, job) => {
          attempts.push({ attempt: job.attempt, at: Date.now() });
          return job.attempt === 1 ? Promise.reject(new Error("HTTP 503")) : Promise.resolve();
        },
        { retries: 2, retryDelaySeconds: 1 },
      ),
    );
    await queue.start();
    await queue.enqueue("discovery.fetch-source", { sourceId: "source-1" }, { key: "source-1" });

    await until(async () => (await jobRows(schema, "discovery.fetch-source"))[0]?.state === "completed");
    assert.deepEqual(
      attempts.map((attempt) => attempt.attempt),
      [1, 2],
    );
    const [first, second] = attempts;
    assert.ok(first && second && second.at - first.at >= 900, "the retry waited for its delay");
    await queue.stop();
  });

  test("a job that fails every try is given up, with a warning for each retry and an error at the end", async () => {
    const lines: { level: string; message: string }[] = [];
    const recording: Logger = {
      debug: () => {},
      info: () => {},
      warn: (_context, message) => lines.push({ level: "warn", message }),
      error: (_context, message) => lines.push({ level: "error", message }),
      child: () => recording,
    };
    const { queue, schema } = newQueue(recording);
    queue.register(
      handler("discovery.fetch-source", () => Promise.reject(new Error("HTTP 503")), {
        retries: 1,
        retryDelaySeconds: 1,
      }),
    );
    await queue.start();
    await queue.enqueue("discovery.fetch-source", { sourceId: "source-1" }, { key: "source-1" });

    await until(async () => (await jobRows(schema, "discovery.fetch-source"))[0]?.state === "failed");
    assert.deepEqual(lines, [
      { level: "warn", message: "A job failed and will be tried again" },
      { level: "error", message: "A job failed for the last time and was given up" },
    ]);
    await queue.stop();
  });

  test("a keyed job is not queued twice while one is waiting; a job with no key always is", async () => {
    const { queue, schema } = newQueue();
    queue.register(handler("discovery.fetch-source", () => Promise.resolve()));
    queue.register(handler("processing.process-pending", () => Promise.resolve()));
    await queue.start();

    // Delayed, so they wait.
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a", delaySeconds: 600 });
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a", delaySeconds: 600 });
    await queue.enqueue("discovery.fetch-source", { sourceId: "b" }, { key: "b", delaySeconds: 600 });
    await queue.enqueue("processing.process-pending", {}, { delaySeconds: 600 });
    await queue.enqueue("processing.process-pending", {}, { delaySeconds: 600 });

    const fetches = await jobRows(schema, "discovery.fetch-source");
    assert.deepEqual(
      fetches.map((row) => row.singleton_key),
      ["a", "b"],
    );
    assert.equal((await jobRows(schema, "processing.process-pending")).length, 2);
    await queue.stop();
  });

  test("a delayed job does not run before its delay", async () => {
    const { queue } = newQueue();
    let ranAt: number | undefined;
    queue.register(
      handler("discovery.fetch-source", () => {
        ranAt = Date.now();
        return Promise.resolve();
      }),
    );
    await queue.start();
    const queuedAt = Date.now();
    await queue.enqueue("discovery.fetch-source", { sourceId: "a" }, { key: "a", delaySeconds: 2 });

    await until(() => ranAt !== undefined);
    assert.ok(ranAt !== undefined && ranAt - queuedAt >= 1900, `ran ${String(ranAt && ranAt - queuedAt)}ms after`);
    await queue.stop();
  });

  test("stop lets a running job finish, and tells it the queue is stopping", async () => {
    const { queue, schema } = newQueue();
    let started = false;
    let finished = false;
    let toldToStop = false;
    queue.register(
      handler("processing.process-pending", async (_payload, job) => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 500));
        toldToStop = job.signal.aborted;
        finished = true;
      }),
    );
    await queue.start();
    await queue.enqueue("processing.process-pending", {}, { key: "pending" });

    await until(() => started);
    await queue.stop();
    assert.equal(finished, true);
    assert.equal(toldToStop, true);
    assert.deepEqual(
      (await jobRows(schema, "processing.process-pending")).map((row) => row.state),
      ["completed"],
    );
  });

  test("a schedule is stored in UTC with its key, and setting it again replaces it", async () => {
    const { queue, schema } = newQueue();
    queue.register(handler("discovery.find-due-sources", () => Promise.resolve()));
    queue.register(handler("processing.process-pending", () => Promise.resolve()));
    await queue.start();

    await queue.schedule("discovery.find-due-sources", "*/30 * * * *", {});
    await queue.schedule("discovery.find-due-sources", "*/15 * * * *", {});
    await queue.schedule("processing.process-pending", "0 * * * *", {}, { key: "pending" });

    const rows = await database.db.execute<{ name: string; cron: string; timezone: string; key: string | null }>(
      sql`select name, cron, timezone, options->>'singletonKey' as key from ${sql.identifier(schema)}.schedule order by name`,
    );
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { name: "discovery.find-due-sources", cron: "*/15 * * * *", timezone: "UTC", key: "discovery.find-due-sources" },
        { name: "processing.process-pending", cron: "0 * * * *", timezone: "UTC", key: "pending" },
      ],
    );
    await queue.stop();
  });

  test("a handler cannot be registered after the queue has started", async () => {
    const { queue } = newQueue();
    await queue.start();
    assert.throws(() => {
      queue.register(handler("discovery.fetch-source", () => Promise.resolve()));
    }, /registered before it starts/);
    await queue.stop();
  });
});
