import type { JobHandler, JobName, JobQueue, Jobs } from "../shared/jobs.ts";

// An in-memory job queue. It records what is registered, queued and scheduled, and runs a queued job only when a
// test asks it to, once or with its policy's retries.

export interface QueuedJob {
  name: JobName;
  payload: Jobs[JobName];
  key: string | undefined;
  delaySeconds: number | undefined;
}

export interface ScheduledJob {
  name: JobName;
  cron: string;
  payload: Jobs[JobName];
  key: string;
}

export interface Attempt {
  attempt: number;
  error: unknown;
}

export class FakeJobQueue implements JobQueue {
  readonly handlers = new Map<JobName, JobHandler>();
  readonly queued: QueuedJob[] = [];
  readonly schedules = new Map<JobName, ScheduledJob>();
  started = false;
  stopped = false;
  // Aborts the signal of the job in hand, as stopping the real queue does.
  readonly stopping = new AbortController();
  #nextId = 1;

  register<N extends JobName>(handler: JobHandler<N>): void {
    if (this.started) throw new Error(`${handler.name} was registered after the queue started.`);
    if (this.handlers.has(handler.name)) throw new Error(`${handler.name} is registered already.`);
    this.handlers.set(handler.name, handler);
  }

  enqueue<N extends JobName>(name: N, payload: Jobs[N], options: { key?: string; delaySeconds?: number } = {}) {
    const waiting = options.key !== undefined && this.queued.some((job) => job.name === name && job.key === options.key);
    if (!waiting) this.queued.push({ name, payload, key: options.key, delaySeconds: options.delaySeconds });
    return Promise.resolve();
  }

  schedule<N extends JobName>(name: N, cron: string, payload: Jobs[N], options: { key?: string } = {}) {
    this.schedules.set(name, { name, cron, payload, key: options.key ?? name });
    return Promise.resolve();
  }

  start() {
    this.started = true;
    return Promise.resolve();
  }

  stop() {
    this.stopped = true;
    this.stopping.abort();
    return Promise.resolve();
  }

  // The queued jobs of one kind.
  jobs(name: JobName): QueuedJob[] {
    return this.queued.filter((job) => job.name === name);
  }

  handler(name: JobName): JobHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler is registered for ${name}.`);
    return handler;
  }

  // Takes the oldest queued job of this kind off the queue and runs it once. Resolves with the error it failed
  // with, or undefined when it succeeded.
  async runNext(name: JobName, attempt = 1): Promise<unknown> {
    const job = this.#take(name);
    return this.#run(name, job.payload, attempt);
  }

  // Runs a job of this kind with a payload, as its schedule would add it.
  async runScheduled(name: JobName): Promise<unknown> {
    const scheduled = this.schedules.get(name);
    if (!scheduled) throw new Error(`${name} has no schedule.`);
    return this.#run(name, scheduled.payload, 1);
  }

  // Takes the oldest queued job of this kind and runs it as the policy says: tried again after each failure
  // until it succeeds or its retries are used up. Resolves with every failed attempt, and the waits before each
  // retry the policy gives.
  async runWithRetries(name: JobName): Promise<{ succeeded: boolean; failures: Attempt[]; waitsSeconds: number[] }> {
    const job = this.#take(name);
    const { policy } = this.handler(name);
    const failures: Attempt[] = [];
    const waitsSeconds: number[] = [];
    for (let attempt = 1; attempt <= policy.retries + 1; attempt += 1) {
      const error = await this.#run(name, job.payload, attempt);
      if (error === undefined) return { succeeded: true, failures, waitsSeconds };
      failures.push({ attempt, error });
      if (attempt <= policy.retries) {
        waitsSeconds.push(policy.retryDelaySeconds * (policy.retryBackoff ? 2 ** (attempt - 1) : 1));
      }
    }
    return { succeeded: false, failures, waitsSeconds };
  }

  #take(name: JobName): QueuedJob {
    const index = this.queued.findIndex((job) => job.name === name);
    const job = this.queued[index];
    if (!job) throw new Error(`No ${name} job is queued.`);
    this.queued.splice(index, 1);
    return job;
  }

  async #run(name: JobName, payload: Jobs[JobName], attempt: number): Promise<unknown> {
    const id = String(this.#nextId);
    this.#nextId += 1;
    try {
      await this.handler(name).run(payload, { id, attempt, signal: this.stopping.signal });
      return undefined;
    } catch (error) {
      return error;
    }
  }
}
