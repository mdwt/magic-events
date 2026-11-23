// The job queue port. Work that happens in the background, on a schedule or after something else, is a job:
// fetching a source, processing what it returned. The queue keeps jobs, runs them, and tries a failed one again.
// It belongs to no domain. What a job does is a handler, written against the domains' inbound ports and against
// this port only, so the queue behind it can be changed by writing one adapter. Version 1's adapter is pg-boss.

// Every job the system runs, and what each carries.
export interface Jobs {
  // Looks for the sources that are due a fetch and adds a fetch job for each.
  "discovery.find-due-sources": Record<string, never>;
  // Fetches one source.
  "discovery.fetch-source": { sourceId: string };
  // Processes the raw listings that are pending, until none is left.
  "processing.process-pending": Record<string, never>;
}

export type JobName = keyof Jobs;

// How the queue treats jobs of one kind.
export interface JobPolicy {
  // How many times a failed job is tried again before it is given up.
  retries: number;
  // How long after a failure the first retry comes.
  retryDelaySeconds: number;
  // True doubles the wait with each retry.
  retryBackoff: boolean;
  // A job that runs longer than this counts as failed.
  timeoutSeconds: number;
  // How many jobs of this kind this process runs at once.
  concurrency: number;
}

// What a job does. A handler that throws fails the job, and the queue tries it again as its policy says.
export interface JobHandler<N extends JobName = JobName> {
  name: N;
  policy: JobPolicy;
  run(payload: Jobs[N], job: { id: string; attempt: number }): Promise<void>;
}

export interface JobQueue {
  // Says what a kind of job does and how it is treated. Called before start, once for each kind.
  register<N extends JobName>(handler: JobHandler<N>): void;
  // Adds a job. With a key, a job of this kind that is already waiting under the same key is not added again.
  enqueue<N extends JobName>(
    name: N,
    payload: Jobs[N],
    options?: { key?: string; delaySeconds?: number },
  ): Promise<void>;
  // Adds the job again and again on a cron schedule, in UTC. Calling it again replaces the schedule of that kind.
  schedule<N extends JobName>(name: N, cron: string, payload: Jobs[N]): Promise<void>;
  // Starts taking jobs. Every handler is registered by now.
  start(): Promise<void>;
  // Stops taking jobs and lets the ones in hand finish.
  stop(): Promise<void>;
}
