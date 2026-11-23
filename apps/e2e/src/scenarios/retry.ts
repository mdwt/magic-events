import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { migrate } from "../harness/cli.ts";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import { databaseUrl, dropDatabase, execute, query } from "../harness/db.ts";
import { ROOT, runNode } from "../harness/process.ts";
import { freePort, LEVEL, type ApiServer, type LogLine } from "../harness/server.ts";
import { startServer } from "../harness/setup.ts";
import { state } from "../harness/state.ts";

// E2E-19 with nothing from the outside world: a source whose page is at a local port that is closed, then opened.
// It runs on a database of its own, seeded, where every seeded source is inactive, so the schedule fetches that
// source alone and no real website.

const SOURCE = "Local page behind a closed port";

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function isRun(line: LogLine): boolean {
  return line.msg === "Run finished" && line.source === SOURCE;
}

export async function failedFetchIsRetried(c: Checks): Promise<void> {
  const name = `${state.dbName}_retry`;
  const url = databaseUrl(name);
  await dropDatabase(name);
  const migrated = await migrate(url);
  if (!c.ok(migrated.code === 0, `migrate: ${migrated.output.slice(-300)}`)) return;
  const env = { ...state.env, DATABASE_URL: url, BETTER_AUTH_SECRET: state.secret, LOG_LEVEL: "debug", LOG_PRETTY: "false" };
  const seeded = await runNode(join(ROOT, "apps/cli/src/seed/run.ts"), [], { env, timeoutMs: 120_000 });
  if (!c.ok(seeded.code === 0, `seed: ${seeded.output.slice(-300)}`)) return;

  const port = await freePort();
  const page = `http://127.0.0.1:${port}/whats-on`;
  // Preparing this database only: the seeded sources are switched off and one source is added at the closed port.
  await execute(url, "update source set active = false");
  await execute(
    url,
    `insert into source (name, kind, location_id, settings, fetch_interval_hours, missed_runs_before_removal, max_processing_attempts, active)
     select '${SOURCE}', 'web_page', id, '{"urls": ["${page}"]}'::jsonb, 168, 3, 3, true from location where slug = 'hermanus'`,
  );

  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body><h1>What is on</h1><p>The Hermanus Country Market, every Saturday.</p></body></html>");
  });
  let server: ApiServer | undefined;
  try {
    server = await startServer("retry", {
      DATABASE_URL: url,
      DISCOVERY_SCHEDULE_CRON: "* * * * *",
      DISCOVERY_FETCH_RETRY_BACKOFF_MINUTES: "1",
      DISCOVERY_FETCH_TIMEOUT_SECONDS: "5",
    });
    const failedRun = await server.waitFor("the first run, which fails", isRun, 150_000);
    c.equal(failedRun.status, "failed", "the first run's status");
    const reason = server.find((line) => line.msg === "The run failed" && line.source === SOURCE);
    c.ok(typeof reason?.error === "string" && reason.error !== "", `the failed run has its reason: ${show(reason?.error)}`);
    const retrying = await server.waitFor(
      "the fetch job failing and being tried again",
      (line) => line.msg === "A job failed and will be tried again" && line.job === "discovery.fetch-source",
      10_000,
    );
    c.ok(retrying.level === LEVEL.warn, "the job's failure is logged at warn");
    const wait = retrying.nextRetryInSeconds as { from?: number; to?: number } | undefined;
    c.ok(wait?.from === 60 && wait.to === 120, `the first retry waits one to two minutes: ${show(wait)}`);
    c.ok(typeof retrying.jobId === "string" && retrying.attempt === 1 && retrying.err !== undefined, `the line has the job, its attempt and the error: ${show(retrying)}`);
    const failedAt = Number(failedRun.time);

    // The host is back.
    await listen(site, port);
    const from = server.lineCount();
    const back = await server.waitFor("the retry, which succeeds", isRun, 200_000, from);
    c.equal(back.status, "succeeded", "the retry's status");
    const waited = (Number(back.time) - failedAt) / 1000;
    c.ok(waited >= 50 && waited <= 180, `the retry came ${Math.round(waited)} s after the failure`);
    const started = server.lines().filter((line) => line.msg === "Job started" && line.job === "discovery.fetch-source");
    c.ok(started.length >= 2 && started.some((line) => line.attempt === 2), `the retry is the same job's second attempt: ${show(started.map((line) => line.attempt))}`);
    c.ok(back.jobId === retrying.jobId, "the run's line carries the job's ID, the same job tried again");

    const runs = await query<{ status: string; error: string | null }>(
      url,
      `select r.status::text as status, r.error from run r join source s on s.id = r.source_id where s.name = '${SOURCE}' order by r.started_at`,
    );
    c.equal(runs.map((run) => run.status), ["failed", "succeeded"], "the source's runs");
    c.equal(failedRun.removed, 0, "the failed run counted no listing as missing");
    const removed = await query<{ n: number }>(url, "select count(*)::int as n from listing where state <> 'listed'");
    c.equal(removed[0]?.n, 0, "listings counted as missing");
  } finally {
    await server?.stop();
    if (site.listening) await close(site);
    await dropDatabase(name);
  }
}
