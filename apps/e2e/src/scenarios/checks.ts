import { existsSync } from "node:fs";
import { join } from "node:path";
import { send, type Call } from "../harness/api.ts";
import { keysPrinted } from "../harness/cli.ts";
import { show } from "../harness/checks.ts";
import { databaseUrl, dropDatabase, one, query } from "../harness/db.ts";
import { addMonths, today, WINTER } from "../harness/feed.ts";
import { lastLines, ROOT, runCommand, runNode, type CommandResult } from "../harness/process.ts";
import { byHand, scenario, skipped } from "../harness/scenario.ts";
import { until } from "../harness/server.ts";
import { prepare, startServer, type Snapshot } from "../harness/setup.ts";
import { client, mainServer, recall, state } from "../harness/state.ts";

// The checks around the scenarios, C-01 to C-08, where the suite can run them.

function repositoryEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  return env;
}

function pnpm(args: string[]): Promise<CommandResult> {
  return runCommand("pnpm", args, { env: repositoryEnv(), cwd: ROOT, timeoutMs: 30 * 60_000 });
}

export function registerSetup(): void {
  scenario(
    "SETUP",
    "The run's database, seed, captures and server",
    async ({ c }) => {
      try {
        await prepare();
      } catch (error) {
        state.setupError = error instanceof Error ? error.message : String(error);
        c.fail(state.setupError);
      }
    },
    { needsSetup: false },
  );

  scenario("C-04", "The migrations apply to an empty database", ({ c }) => {
    const found = recall<{ first: CommandResult; second: CommandResult; applied: number; again: number }>("C-04");
    if (found === undefined) {
      c.fail("The migrations did not run");
      return Promise.resolve();
    }
    c.ok(found.first.code === 0, `the first migration exited with ${String(found.first.code)}`);
    c.ok(found.second.code === 0, `the second migration exited with ${String(found.second.code)}`);
    c.ok(found.applied > 0, `${found.applied} migrations applied`);
    c.equal(found.again, found.applied, "migrations recorded after the second run");
    c.saw(`migrate on an empty database: exit ${String(found.first.code)}, ${found.applied} migrations; again: exit ${String(found.second.code)}, still ${found.again}`);
    return Promise.resolve();
  });

  scenario("C-05", "The seed runs twice without changing anything", ({ c }) => {
    const found = recall<{ first: CommandResult; second: CommandResult; before: Snapshot; after: Snapshot }>("C-05");
    if (found === undefined) {
      c.fail("The seed did not run");
      return Promise.resolve();
    }
    const counts = (text: string) => /Default data seeded: .*/.exec(text)?.[0];
    c.ok(counts(found.first.stdout) !== undefined && /NEW API KEYS/.test(found.first.stdout), "the first seed prints the counts and the new keys");
    c.equal(counts(found.second.stdout), counts(found.first.stdout), "the second seed's counts");
    c.ok(/No new API keys/.test(found.second.stdout), "the second seed says No new API keys");
    c.equal(found.after.rows, found.before.rows, "rows after the second seed");
    const tables = Object.keys(found.before.digests);
    const changed = tables.filter((table) => found.before.contents[table] !== found.after.contents[table]);
    c.equal(changed, [], "tables with a row whose content the second seed changed");
    const touched = tables.filter((table) => !changed.includes(table) && found.before.digests[table] !== found.after.digests[table]);
    c.equal(touched, [], "tables whose rows the second seed wrote again unchanged, with a new updated_at");
    c.saw(`seed: "${counts(found.first.stdout) ?? ""}" and ${String(found.first.stdout.match(/mev_/g)?.length ?? 0)} keys; again: the same counts, "No new API keys", no row of ${tables.length} tables changed`);
    return Promise.resolve();
  });

  scenario("C-06", "The server starts cleanly", async ({ c }) => {
    const main = mainServer();
    const lines = main.lines();
    c.ok(lines.some((line) => /listening/i.test(String(line.msg))), "the server logs that it is listening");
    const jobs = lines.find((line) => line.msg === "The jobs started");
    c.ok(jobs !== undefined && typeof jobs.findDueSourcesCron === "string" && typeof jobs.upkeepCron === "string", "it logs that the jobs started, with each schedule");
    const settings = lines.find((line) => line.msg === "Server started");
    c.ok(settings !== undefined && typeof settings.port === "number", "it logs the settings that are safe to show when it starts");
    c.ok(!main.text().includes(state.secret) && !main.text().includes(state.dbUrl), "no secret or database address in the start lines");
    c.equal((await send(main, { path: "/health" })).status, 200, "/health");
    c.saw(`"Server started" port ${String(settings?.port)}, log level ${String(settings?.logLevel)}, no secret; "The jobs started" with ${String(jobs?.findDueSourcesCron)} and ${String(jobs?.upkeepCron)}; /health 200`);
  });
}

export function registerChecks(): void {
  byHand("C-01", "A clean install", "pnpm install --frozen-lockfile in a fresh checkout: the suite runs inside an installed worktree.");

  scenario("C-02", "The workspace type checks, lints and builds", async ({ c }) => {
    if (state.skipChecks) {
      c.note("Skipped with E2E_SKIP_CHECKS=1.");
      return;
    }
    const exits: string[] = [];
    for (const script of ["typecheck", "lint", "build"]) {
      const result = await pnpm([script]);
      c.ok(result.code === 0, `pnpm ${script} exited with ${String(result.code)}: ${lastLines(result.output, 8)}`);
      exits.push(`pnpm ${script} exit ${String(result.code)}`);
    }
    c.saw(exits.join(", "));
  });

  scenario("C-03", "Every automated test passes", async ({ c }) => {
    if (state.skipChecks) {
      c.note("Skipped with E2E_SKIP_CHECKS=1.");
      return;
    }
    const migrated = await pnpm(["db:migrate:test"]);
    c.ok(migrated.code === 0, `pnpm db:migrate:test exited with ${String(migrated.code)}: ${lastLines(migrated.output, 5)}`);
    const tested = await pnpm(["test"]);
    c.ok(tested.code === 0, `pnpm test exited with ${String(tested.code)}: ${lastLines(tested.output, 12)}`);
    // Each project's runner ends with its counts, as "ℹ skipped 0" or, in TAP, "# skipped 0".
    const skipped = [...tested.output.matchAll(/^(?:#|ℹ) (skipped|todo) (\d+)$/gm)].filter((match) => Number(match[2]) > 0);
    c.equal(skipped.map((match) => match[0]), [], "tests skipped");
    const passed = [...tested.output.matchAll(/^(?:#|ℹ) pass (\d+)$/gm)].reduce((total, match) => total + Number(match[1]), 0);
    c.saw(`pnpm db:migrate:test exit ${String(migrated.code)}; pnpm test exit ${String(tested.code)}, ${passed} passed, ${skipped.length} projects with skipped tests`);
    c.note(`${passed} tests passed.`);
  });

  newCheckout();

  byHand("C-07", "The background jobs run", "Within an hour of a server starting, pgboss.job shows a completed job of each of the four queues: the suite does not wait an hour.");

  scenario("C-08", "Upkeep keeps the feed current", async ({ c, logs }) => {
    const upkeep = await startServer("upkeep", { CATALOGUE_UPKEEP_CRON: "* * * * *" });
    try {
      const line = await upkeep.waitFor("the upkeep to run", (one) => one.msg === "Kept the catalogue up", 180_000);
      c.note(`Upkeep: ${show(line)}`);
      const over = await query<{ title: string }>(
        state.dbUrl,
        `select e.title from experience e where e.status in ('expected','announced','confirmed','postponed')
           and (select max(s.end_date) from experience_session s where s.experience_id = e.id) < current_date`,
      );
      c.equal(over.map((one) => one.title), [], "searchable experiences whose last session is before today");
      const horizon = addMonths(today(), 24);
      // A rule limited to some months, such as December and January, has its last session in the last of those
      // months before the horizon, so it is allowed a year.
      const short = await query<{ title: string; last: string }>(
        state.dbUrl,
        `select e.title, max(s.start_date)::text as last from experience e join experience_session s on s.experience_id = e.id
          where e.recurrence_rule is not null and e.recurrence_end is null and e.status in ('expected','announced','confirmed','postponed')
          group by e.id, e.title, e.recurrence_rule
         having max(s.start_date) < date '${horizon}' - (case when e.recurrence_rule like '%BYMONTH%' then interval '12 months' else interval '1 month' end)`,
      );
      c.equal(short.map((one) => `${one.title} (${one.last})`), [], `open-ended recurring experiences without sessions up to ${horizon}`);
      c.equal((await send(upkeep, { path: "/v1/experiences/search", client: client("agency person"), body: WINTER })).status, 200, "search after upkeep");
      c.saw(`upkeep every minute: "Kept the catalogue up" past ${String(line.past)}, closed ${String(line.bookingsClosed)}, generated ${String(line.sessionsGenerated)}; ${over.length} searchable experiences over, ${short.length} recurring short of ${horizon}`);
    } finally {
      await upkeep.stop();
    }
    logs((lc) => {
      const lines = upkeep.lines();
      const kept = lines.find((one) => one.msg === "Kept the catalogue up");
      lc.ok(kept !== undefined, "the upkeep job is in the log");
      const started = lines.find((one) => one.msg === "Job started" && one.job === "catalogue.keep-up");
      const finished = lines.find((one) => one.msg === "Job finished" && one.job === "catalogue.keep-up");
      lc.ok(started !== undefined && finished !== undefined && typeof finished.durationMs === "number", "the job's start and finish are logged, with its duration");
      lc.ok(kept?.jobId !== undefined && kept.jobId === started?.jobId, "the job's own lines carry its ID");
    });
  });
}

const SNAPSHOT = join(ROOT, "packages/db/snapshot/hermanus.sql.gz");

// C-09: what pnpm quickstart does, restore then seed, into a database of the run's own, never magic_events.
function newCheckout(): void {
  if (!existsSync(SNAPSHOT)) {
    skipped("C-09", "A new checkout starts with a full feed", "packages/db/snapshot/hermanus.sql.gz does not exist yet: it is saved after the data fixes.");
    return;
  }
  scenario("C-09", "A new checkout starts with a full feed", async ({ c }) => {
    const name = `${state.dbName}_snapshot`;
    const url = databaseUrl(name);
    const env = { ...state.env, DATABASE_URL: url, BETTER_AUTH_SECRET: state.secret, LOG_LEVEL: "warn", LOG_PRETTY: "false" };
    await dropDatabase(name);
    try {
      const restored = await runNode(join(ROOT, "packages/db/src/cli/snapshot.ts"), ["restore"], { env, timeoutMs: 600_000 });
      if (!c.ok(restored.code === 0, `the restore exited with ${String(restored.code)}: ${lastLines(restored.output, 5)}`)) return;
      const seeded = await runNode(join(ROOT, "apps/cli/src/seed/run.ts"), [], { env, timeoutMs: 120_000 });
      c.ok(seeded.code === 0 && /NEW API KEYS/.test(seeded.stdout), `the seed prints the new keys: ${lastLines(seeded.output, 3)}`);
      const printed = keysPrinted(seeded.stdout).find((key) => key.email === "planner@agency.example.com" && key.kind === "person");
      if (!c.ok(printed !== undefined, "the seed printed the Agency Planner's person key") || printed === undefined) return;
      state.keys.add(printed.key);
      const ids = await one<{ user_id: string; tenant_id: string; credential_id: string }>(
        url,
        `select u.id as user_id, u.tenant_id, k.id as credential_id from "user" u join apikey k on k.reference_id = u.id
          where u.email = 'planner@agency.example.com' and k.name = 'seed person key'`,
      );
      const server = await startServer("snapshot", { DATABASE_URL: url });
      const planner = {
        label: "snapshot agency person",
        key: printed.key,
        email: printed.email,
        userId: ids.user_id,
        tenantId: ids.tenant_id,
        tenantSlug: "example-travel-agency",
        kind: "person" as const,
        role: "client" as const,
        credentialId: ids.credential_id,
      };
      let answer: Call | undefined;
      let changed: Call | undefined;
      let september: Call | undefined;
      try {
        answer = await send(server, {
          path: "/v1/experiences/search",
          client: planner,
          body: { location: "hermanus", from: today(), to: addMonths(today(), 24), limit: 100 },
        });
        // The nine changes made for demonstration, as packages/db/snapshot/README.md lists them.
        changed = await send(server, {
          path: "/v1/experiences/changes",
          client: planner,
          body: { location: "hermanus", from: "2026-12-01", to: "2027-09-30", since: "2026-11-23T17:10:00Z", limit: 100 },
        });
        september = await send(server, {
          path: "/v1/experiences/search",
          client: planner,
          body: { location: "hermanus", from: "2027-09-20", to: "2027-09-30" },
        });
      } finally {
        await server.stop();
      }
      const items = (changed.json as { items?: { experience: { title: string }; change: { kind: string } }[] } | undefined)?.items ?? [];
      c.equal(changed.status, 200, "the changes call on the snapshot");
      c.sameSet(
        items.map((item) => item.experience.title),
        [
          "Neil Diamond Tribute - Johan Liebenberg",
          "Crimson House",
          "Riaan Benadé Live",
          "A Tribute to Elton John",
          "The Latin Guitar with James Grace",
          "Ballyhoo: The 50 Year Celebration",
          "Stanford Festive Market",
          "Studio 54 New Years Eve Party",
          "ISA Miniature Convention",
        ],
        "the nine demonstration changes",
      );
      const kindOf = (title: string) => items.find((item) => item.experience.title === title)?.change.kind;
      c.equal(
        [kindOf("Neil Diamond Tribute - Johan Liebenberg"), kindOf("Crimson House"), kindOf("Riaan Benadé Live"), kindOf("Ballyhoo: The 50 Year Celebration"), kindOf("Studio 54 New Years Eve Party")],
        ["cancelled", "postponed", "rescheduled", "confirmed", "removed"],
        "the kinds of the cancelled, postponed, rescheduled, confirmed and removed ones",
      );
      c.equal(items.filter((item) => item.change.kind === "changed").length, 4, "changes of kind changed");
      const first = (september.json as { items?: { title: string }[] } | undefined)?.items?.[0]?.title;
      c.equal(first, "Private whale watching charter with Southern Right Charters", "the first of 20 to 30 September 2027 on the snapshot");
      const total = (answer.json as { total?: number } | undefined)?.total ?? 0;
      const searchable = await one<{ n: number }>(url, "select count(*)::int as n from experience where status in ('expected','announced','confirmed','postponed')");
      c.ok(answer.status === 200 && total > 0, `a search with the new key returns the snapshot's experiences: ${answer.status}, total ${total} of ${searchable.n}`);
      const unembedded = await one<{ n: number }>(
        url,
        "select count(*)::int as n from experience where status in ('expected','announced','confirmed','postponed') and embedding is null",
      );
      c.equal(unembedded.n, 0, "searchable experiences without an embedding");
      const again = await runNode(join(ROOT, "packages/db/src/cli/snapshot.ts"), ["restore"], { env, timeoutMs: 120_000 });
      c.ok(again.code !== 0 && /already has tables/.test(again.output), `restore run again changes nothing and says so: ${lastLines(again.output, 2)}`);
      c.saw(
        `restore and seed: a search with the new key: ${answer.status}, total ${total}; ${searchable.n} searchable, ${unembedded.n} without an embedding; ` +
          `changes since 17:10: ${items.length} (${items.map((item) => `${item.experience.title}: ${item.change.kind}`).join(", ")}); 20 to 30 Sep 2027 first "${String(first)}"; restore again: exit ${String(again.code)}, "already has tables"`,
      );
    } finally {
      await dropDatabase(name);
    }
  });
}

// Last: the main server stops cleanly on SIGTERM, finishing the request in hand.
export function registerStop(): void {
  scenario("C-06", "The server stops cleanly", async ({ c }) => {
    const main = mainServer();
    const from = main.lineCount();
    const inHand = send(main, { path: "/v1/experiences/search", client: client("agency person"), body: { ...WINTER, limit: 100 } });
    await until("the request to reach the server", () => main.find((line) => line.msg === "Request started", from), 5_000, 20);
    const code = await main.stop("SIGTERM");
    const answered = await inHand.catch(() => undefined);
    c.equal(answered?.status, 200, "the request in hand when it stopped");
    c.equal(code, 0, "exit code");
    const messages = main.lines(from).map((line) => String(line.msg));
    const stopping = messages.indexOf("Stopping");
    const stopped = messages.indexOf("Stopped");
    c.ok(stopping !== -1 && stopped > stopping, `it logs "Stopping" then "Stopped": ${show(messages.slice(-6))}`);
    c.saw(`SIGTERM with a search in hand: the search ${String(answered?.status)}, "Stopping" then "Stopped", exit ${String(code)}`);
  });
}
