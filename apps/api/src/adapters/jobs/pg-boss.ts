import { randomUUID } from "node:crypto";
import { PgBoss, type Job, type QueueOptions } from "pg-boss";
import type { JobHandler, JobName, JobPolicy, JobQueue, Jobs } from "../../core/shared/jobs.ts";
import type { Logger } from "../../core/shared/logger.ts";

// The job queue on Postgres, through pg-boss. pg-boss keeps its jobs, queues and schedules in a schema of its own,
// which it creates and migrates itself when it starts, apart from the application's tables.
//
// Every queue has the "short" policy: at most one job per key is waiting, any number run. That is how a key keeps a
// job from being added twice. A job enqueued without a key gets a key of its own, so it is always added.
//
// A retry with backoff waits, after failed try n, between retryDelay * 2^(n-1) and twice that: pg-boss adds a random
// part to spread retries out. Without backoff it waits retryDelay exactly.

const SCHEMA = "pgboss";
// How long stop waits for the jobs in hand. A job still running after this is failed, and tried again later.
const STOP_TIMEOUT_SECONDS = 30;

export function createJobQueue(deps: {
  databaseUrl: string;
  logger: Logger;
  // The schema pg-boss keeps its tables in. Tests use one of their own.
  schema?: string;
  // How often an idle worker looks for jobs. pg-boss's default is 2 seconds.
  pollingIntervalSeconds?: number;
}): JobQueue {
  const logger = deps.logger.child({ component: "job-queue" });
  const boss = new PgBoss({
    connectionString: deps.databaseUrl,
    schema: deps.schema ?? SCHEMA,
    application_name: "magic-events-jobs",
  });
  // pg-boss reports its own failures (maintenance, schedules, polling) as events. An error with no listener
  // would end the process.
  boss.on("error", (error) => {
    logger.error({ err: error }, "The job queue failed");
  });
  boss.on("warning", (warning) => {
    logger.warn({ data: warning.data }, warning.message);
  });

  const handlers = new Map<JobName, JobHandler>();
  // Aborted when stop begins, so a long handler stops between its items instead of at the stop timeout.
  const stopping = new AbortController();
  let started = false;
  // Stopping twice waits for the one stop.
  let stopped: Promise<void> | undefined;

  async function run(handler: JobHandler, job: Job<Jobs[JobName]>): Promise<void> {
    const attempt = job.retryCount + 1;
    const signal = AbortSignal.any([job.signal, stopping.signal]);
    try {
      await handler.run(job.data, { id: job.id, attempt, signal });
    } catch (error) {
      logFailure(handler.name, handler.policy, job, error);
      throw error;
    }
    // pg-boss failed the job when it ran past its timeout, whatever the handler did after.
    if (job.signal.aborted && !stopping.signal.aborted) {
      logFailure(handler.name, handler.policy, job, job.signal.reason);
    }
  }

  function logFailure(name: JobName, policy: JobPolicy, job: Job<Jobs[JobName]>, error: unknown): void {
    const context = { err: error, job: name, jobId: job.id, attempt: job.retryCount + 1, retries: policy.retries };
    if (job.retryCount < policy.retries) {
      logger.warn({ ...context, nextRetryInSeconds: nextWait(policy, job.retryCount) }, "A job failed and will be tried again");
    } else {
      logger.error(context, "A job failed for the last time and was given up");
    }
  }

  return {
    register(handler) {
      if (started) throw new Error(`The job queue has started; ${handler.name} must be registered before it starts.`);
      if (handlers.has(handler.name)) throw new Error(`A handler for ${handler.name} is registered already.`);
      handlers.set(handler.name, handler);
    },

    async enqueue(name, payload, options = {}) {
      const id = await boss.send(name, payload, {
        singletonKey: options.key ?? randomUUID(),
        ...(options.delaySeconds === undefined ? {} : { startAfter: options.delaySeconds }),
      });
      if (id === null) logger.debug({ job: name, key: options.key }, "A job with this key is waiting already");
    },

    async schedule(name, cron, payload, options = {}) {
      await boss.schedule(name, cron, payload, { tz: "UTC", singletonKey: options.key ?? name });
    },

    async start() {
      await boss.start();
      started = true;
      try {
        for (const handler of handlers.values()) {
          const options = queueOptions(handler.policy);
          // Queues are created before anything is sent to them. createQueue leaves an existing queue as it is,
          // so its options are set again, in case a setting changed.
          await boss.createQueue(handler.name, { ...options, policy: "short" });
          await boss.updateQueue(handler.name, options);
          await boss.work<Jobs[JobName]>(
            handler.name,
            {
              localConcurrency: handler.policy.concurrency,
              ...(deps.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: deps.pollingIntervalSeconds }),
            },
            async (jobs) => {
              for (const job of jobs) await run(handler, job);
            },
          );
        }
      } catch (error) {
        await boss.stop({ graceful: false });
        throw error;
      }
      logger.debug({ queues: [...handlers.keys()] }, "The job queue started");
    },

    async stop() {
      if (!started) return;
      stopped ??= (async () => {
        stopping.abort(new Error("The job queue is stopping."));
        await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_SECONDS * 1000 });
      })();
      await stopped;
    },
  };
}

function queueOptions(policy: JobPolicy): QueueOptions {
  return {
    retryLimit: policy.retries,
    retryDelay: policy.retryDelaySeconds,
    retryBackoff: policy.retryBackoff,
    expireInSeconds: policy.timeoutSeconds,
  };
}

// The wait before the retry that follows failed try `retryCount + 1`, as pg-boss works it out.
function nextWait(policy: JobPolicy, retryCount: number): { from: number; to: number } {
  if (!policy.retryBackoff) return { from: policy.retryDelaySeconds, to: policy.retryDelaySeconds };
  const from = (Math.max(policy.retryDelaySeconds, 1) * 2 ** Math.min(16, retryCount + 1)) / 2;
  return { from, to: from * 2 };
}
