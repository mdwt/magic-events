import { join } from "node:path";
import { send, type Client } from "../harness/api.ts";
import { keysPrinted, migrate, pipeline, printedOf } from "../harness/cli.ts";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import { databaseUrl, dropDatabase, execute, one, query } from "../harness/db.ts";
import { searchAll, titled, WINTER, type SearchResult } from "../harness/feed.ts";
import { ROOT, runNode } from "../harness/process.ts";
import { startServer } from "../harness/setup.ts";
import { state } from "../harness/state.ts";

// The scenarios that call the outside world, run by pnpm e2e:live: real websites, the real language model and
// Bedrock. Each is skipped with its reason when a key it needs is missing.

function missing(names: string[]): string[] {
  return names.filter((name) => (state.env[name] ?? "") === "");
}

// E2E-18: on a database of its own, freshly seeded, the schedule fills an empty feed from one real source.
export async function liveSchedule(c: Checks): Promise<void> {
  const absent = missing(["ANTHROPIC_API_KEY", "AWS_REGION"]);
  if (absent.length > 0) {
    c.note(`Skipped: ${absent.join(" and ")} not set.`);
    return;
  }
  const name = `${state.dbName}_live`;
  const url = databaseUrl(name);
  await dropDatabase(name);
  const migrated = await migrate(url);
  if (!c.ok(migrated.code === 0, `migrate: ${migrated.output.slice(-300)}`)) return;
  const env = { ...state.env, DATABASE_URL: url, BETTER_AUTH_SECRET: state.secret, LOG_LEVEL: "debug", LOG_PRETTY: "false" };
  const seeded = await runNode(join(ROOT, "apps/cli/src/seed/run.ts"), [], { env, timeoutMs: 120_000 });
  if (!c.ok(seeded.code === 0, `seed: ${seeded.output.slice(-300)}`)) return;
  // One small source, so the run is short: the others are left inactive on this database only.
  const source = "Hermanus FynArts";
  await execute(url, `update source set active = (name = '${source}')`);

  const server = await startServer("live-schedule", { DATABASE_URL: url, DISCOVERY_SCHEDULE_CRON: "* * * * *" });
  try {
    const jobs = server.find((line) => line.msg === "The jobs started");
    c.ok(jobs?.findDueSourcesCron === "* * * * *", `the log says the jobs started, with each schedule: ${show(jobs)}`);
    const run = await server.waitFor("the source's run", (line) => line.msg === "Run finished" && line.source === source, 10 * 60_000);
    c.ok(run.status === "succeeded", `the run: ${show(run)}`);
    await server.waitFor("processing", (line) => line.msg === "Processed pending raw listings" && Number(line.processed) > 0, 60 * 60_000);
    await server.waitFor("embedding", (line) => line.msg === "Embedded experiences" && line.remaining === 0, 30 * 60_000);
    const processed = await runNode(join(ROOT, "apps/cli/src/pipeline.ts"), ["process"], { env, timeoutMs: 600_000 });
    c.ok(/Nothing was pending\./.test(processed.stdout), `pipeline process: ${printedOf(processed).trim().slice(-200)}`);
    const embedded = await runNode(join(ROOT, "apps/cli/src/pipeline.ts"), ["embed"], { env, timeoutMs: 600_000 });
    c.ok(/ 0 remain\./.test(embedded.stdout), `pipeline embed: ${printedOf(embedded).trim().slice(-200)}`);
    const runs = await query<{ status: string; error: string | null }>(url, "select status::text as status, error from run");
    for (const one of runs) c.ok(one.status === "succeeded" || (one.error ?? "") !== "", `a run ${one.status} with no reason`);

    const printed = keysPrinted(seeded.stdout).find((key) => key.email === "planner@agency.example.com" && key.kind === "person");
    if (!c.ok(printed !== undefined, "the live seed printed the Agency Planner's key") || printed === undefined) return;
    state.keys.add(printed.key);
    const ids = await one<{ user_id: string; tenant_id: string; credential_id: string }>(
      url,
      `select u.id as user_id, u.tenant_id, k.id as credential_id from "user" u join apikey k on k.reference_id = u.id
        where u.email = 'planner@agency.example.com' and k.name = 'seed person key'`,
    );
    const planner: Client = {
      label: "live agency person",
      key: printed.key,
      email: printed.email,
      userId: ids.user_id,
      tenantId: ids.tenant_id,
      tenantSlug: "example-travel-agency",
      kind: "person",
      role: "client",
      credentialId: ids.credential_id,
    };
    const call = await send(server, { path: "/v1/experiences/search", client: planner, body: { ...WINTER, limit: 100, query: "art festival" } });
    const result = call.json as SearchResult;
    const festival = titled(result.items, "2027 Hermanus FynArts Festival")[0];
    c.ok(festival !== undefined, `the winter stay returns the FynArts Festival: ${show(result.items.map((item) => item.title))}`);
    const searched = server.find((line) => line.requestId === call.requestId && line.msg === "Searched experiences");
    c.ok(searched?.byMeaning === true, "a query text orders by meaning, with a real embedding");
  } finally {
    await server.stop();
    await dropDatabase(name);
  }
}

// E2E-21, live part: fetching a seeded source twice in a row changes nothing the second time.
export async function liveRefetchUnchanged(c: Checks): Promise<void> {
  const before = await query<{ id: string; version: number }>(state.dbUrl, "select id, version from experience order by id");
  const first = await pipeline(["refetch", "--source", "Wesgro Cape Overberg events"]);
  const second = await pipeline(["refetch", "--source", "Wesgro Cape Overberg events"]);
  c.ok(first.code === 0 && second.code === 0, `the refetches exited with ${String(first.code)} and ${String(second.code)}`);
  c.ok(/: \d+ found, 0 new or changed/.test(second.stdout), `the second refetch reports 0 new or changed: ${printedOf(second).trim()}`);
  const after = await query<{ id: string; version: number }>(state.dbUrl, "select id, version from experience order by id");
  c.equal(after, before, "no experience has a new version");
}

// E2E-25, live part: refetch by location, source and listing, and reprocess processed straight away.
export async function liveRefetch(c: Checks): Promise<void> {
  if (missing(["ANTHROPIC_API_KEY"]).length > 0) {
    c.note("The live refetch and reprocess are skipped: ANTHROPIC_API_KEY is not set.");
    return;
  }
  const location = await pipeline(["refetch", "--location", "hermanus"]);
  c.ok(/^ {2}.+: \d+ found, \d+ new or changed, \d+ unchanged, \d+ removed/m.test(location.stdout), "refetch --location prints a line per source with its counts");
  const source = await pipeline(["refetch", "--source", "Hermanus FynArts"]);
  c.ok(/Hermanus FynArts: \d+ found/.test(source.stdout), `refetch --source: ${printedOf(source).trim().slice(-200)}`);
  const listing = await query<{ id: string }>(
    state.dbUrl,
    "select l.id from listing l join source s on s.id = l.source_id where s.name = 'Hermanus FynArts' limit 1",
  );
  const id = listing[0]?.id;
  if (c.ok(id !== undefined, "a listing of Hermanus FynArts to refetch") && id !== undefined) {
    const one = await pipeline(["refetch", "--listing", id]);
    c.ok(/belongs to Hermanus FynArts, which is fetched whole/.test(one.stdout), `refetch --listing names its source: ${printedOf(one).trim().slice(-200)}`);
  }
  const festival = titled(await searchAll(WINTER), "2027 Hermanus FynArts Festival")[0];
  if (festival) {
    const again = await pipeline(["reprocess", "--experience", festival.slug, "--now"]);
    c.ok(/Sent \d+ listings back/.test(again.stdout) && /Processed \d+ raw listings/.test(again.stdout), "reprocess --experience --now processes them");
    const now = titled(await searchAll(WINTER), "2027 Hermanus FynArts Festival");
    c.equal(now.map((item) => item.id), [festival.id], "the FynArts Festival keeps its ID, and there is one");
  }
  const sent = await pipeline(["reprocess", "--source", "Quicket public pages"]);
  c.ok(sent.code === 0, `reprocess --source: ${printedOf(sent).trim()}`);
  const processed = await pipeline(["process"]);
  c.ok(processed.code === 0 && !/FAILED/.test(processed.stdout), `pipeline process: ${printedOf(processed).trim().slice(-300)}`);
}
