import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capturedSources, captures, logLinesOf, pipeline, printedOf } from "../harness/cli.ts";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import { one, query, literal } from "../harness/db.ts";
import { DECEMBER, search, searchAll, sessionDays, titled, WINTER } from "../harness/feed.ts";
import type { CommandResult } from "../harness/process.ts";
import { byHand, scenario } from "../harness/scenario.ts";
import { recall, remember, state } from "../harness/state.ts";

// The feed keeps itself current (UC3), on the end-to-end database: E2E-18 to E2E-25.

interface CapturedEntry {
  rawFile: string;
  title: string;
  status: string;
  booking: string;
  sessions: { start: string; end?: string | null; precision: string; startTime?: string | null; endTime?: string | null }[];
  price?: { min?: number | null; max?: number | null; currency?: string | null } | null;
  bookingUrl?: string | null;
  [key: string]: unknown;
}

function extractedPath(slug: string): string {
  return join(state.capturesDir, "extracted", `${slug}.json`);
}

export function readExtracted(slug: string): CapturedEntry[] {
  return JSON.parse(readFileSync(extractedPath(slug), "utf8")) as CapturedEntry[];
}

// Changes a captured page and its entry in extracted/<source>.json together, so what was read from the page agrees
// with the page.
function edit(slug: string, file: string, change: (entry: CapturedEntry) => void, page: (text: string) => string): void {
  const rawFile = `raw/${slug}/${file}`;
  const entries = readExtracted(slug);
  const entry = entries.find((one) => one.rawFile === rawFile);
  if (entry === undefined) throw new Error(`No captured experience names ${rawFile}`);
  change(entry);
  writeFileSync(extractedPath(slug), `${JSON.stringify(entries, null, 2)}\n`);
  const path = join(state.capturesDir, rawFile);
  writeFileSync(path, page(readFileSync(path, "utf8")));
}

interface Version {
  id: string;
  title: string;
  version: number;
  status: string;
}

function versions(): Promise<Version[]> {
  return query<Version>(state.dbUrl, "select id, title, version, status::text as status from experience order by id");
}

function checkNoFailure(c: Checks, result: CommandResult, what: string): void {
  c.ok(result.code === 0, `${what} exited with ${String(result.code)}: ${printedOf(result).slice(-400)}`);
  c.ok(!/FAILED/.test(result.output), `${what} reports a failure: ${(/.*FAILED.*/.exec(result.output) ?? [""])[0]}`);
}

// Every domain event recorded since a time has one info line "Domain event published" with its ID in the commands'
// logs, and no line is for an event that was not recorded, such as one of a transaction that rolled back.
async function checkDomainEvents(c: Checks, results: CommandResult[], since: string): Promise<void> {
  const recorded = await query<{ id: string; type: string }>(state.dbUrl, `select id, type from events where recorded_at >= ${literal(since)}`);
  const lines = results.flatMap(logLinesOf).filter((line) => line.msg === "Domain event published");
  c.ok(recorded.length > 0, "the commands recorded domain events");
  const missing = recorded.filter((event) => lines.filter((line) => line.eventId === event.id && line.type === event.type).length !== 1);
  c.equal(missing.length, 0, `recorded events without exactly one "Domain event published" line (of ${recorded.length})`);
  c.ok(lines.every((line) => line.level === 30 && line.component === "domain-events" && typeof line.resourceId === "string"), "each event's line is at info with its component and resource");
  const ids = new Set(recorded.map((event) => event.id));
  const stray = lines.filter((line) => !ids.has(String(line.eventId)));
  c.equal(stray.length, 0, "event lines for events that were not recorded");
}

function sourceLine(result: CommandResult, name: string) {
  return capturedSources(result.stdout).find((line) => line.name === name);
}

export function registerFeed(): void {
  scenario(
    "E2E-18",
    "The schedule fills an empty feed by itself",
    async ({ c }) => {
      const { liveSchedule } = await import("./live.ts");
      await liveSchedule(c);
    },
    { live: true },
  );

  byHand(
    "E2E-19",
    "A failed fetch is tried again",
    "Needs a source's host made unreachable and then reachable (/etc/hosts) while a server runs its schedule with DISCOVERY_FETCH_RETRY_BACKOFF_MINUTES=1, for several minutes.",
  );

  scenario("E2E-20", "Scraped sources load through the same pipeline", async ({ c, logs }) => {
    const loaded = recall<CommandResult>("load");
    if (loaded === undefined) {
      c.fail("The load did not run");
      return;
    }
    checkNoFailure(c, loaded, "The captures load");
    const manifest = JSON.parse(readFileSync(join(state.capturesDir, "sources.json"), "utf8")) as { sources: { name: string }[] };
    const lines = capturedSources(loaded.stdout);
    for (const source of manifest.sources) {
      c.ok(lines.some((line) => line.name === source.name && !line.failed), `"${source.name}" is loaded`);
    }
    const summary = /(\d+) sources, \d+ listings, \d+ experiences captured: (\d+) saved, (\d+) new, \d+ changed, (\d+) failed\./.exec(loaded.stdout);
    c.ok(summary !== null, "the summary names how many experiences were saved and how many were new");
    if (summary) c.equal(summary[4], "0", "failed in the summary");
    logs(async (lc) => {
      const t0 = recall<string>("T0") ?? "1970-01-01T00:00:00Z";
      const lines = logLinesOf(loaded);
      const finished = lines.filter((line) => line.msg === "Run finished");
      lc.ok(finished.length === manifest.sources.length, `the load logs each run finished with its counts (${finished.length} of ${manifest.sources.length})`);
      lc.ok(finished.every((line) => typeof line.found === "number" && typeof line.newOrChanged === "number"), "each run's line has its counts");
      lc.ok(lines.some((line) => line.msg === "Run started"), "the load logs each run started");
      lc.ok(lines.some((line) => line.msg === "Raw listing processed" && typeof line.experiences === "number"), "each raw listing processed is logged with its outcome");
      lc.ok(lines.some((line) => line.msg === "Experience published"), "each experience published is logged");
      await checkDomainEvents(lc, [loaded], t0);
    });
    const runs = await query<{ status: string; n: number }>(state.dbUrl, "select status::text as status, count(*)::int as n from run group by 1");
    c.equal(runs.filter((run) => run.status !== "succeeded"), [], "runs that did not succeed");
    const raw = await query<{ status: string; n: number }>(state.dbUrl, "select status::text as status, count(*)::int as n from raw_listing group by 1");
    c.equal(raw.filter((one) => one.status !== "processed"), [], "raw listings not processed");
    if (state.live) {
      const embed = recall<CommandResult>("embed");
      c.ok(embed !== undefined && / 0 remain\./.test(embed.stdout), `pipeline embed leaves 0: ${embed?.stdout.trim() ?? ""}`);
    } else {
      c.note("pipeline embed is run by pnpm e2e:live: this run has no AWS settings.");
    }
  });

  scenario("E2E-21", "An unchanged listing changes nothing", async ({ c, logs }) => {
    await search(DECEMBER);
    remember("T1", new Date().toISOString());
    const before = await versions();
    const again = await captures();
    checkNoFailure(c, again, "The second load");
    const lines = capturedSources(again.stdout);
    for (const line of lines) c.ok(line.newOrChanged === 0, `${line.name}: ${line.newOrChanged} new or changed on the second load`);
    c.ok(/: \d+ saved, 0 new, 0 changed, 0 failed\./.test(again.stdout), "the second load's summary is 0 new and 0 changed");
    c.equal(await versions(), before, "no experience has a new version");
    if (state.live) {
      const { liveRefetchUnchanged } = await import("./live.ts");
      await liveRefetchUnchanged(c);
    } else {
      c.note('pipeline refetch --source "Wesgro Cape Overberg events" fetches the live site: it runs with pnpm e2e:live.');
    }
    logs((lc) => {
      lc.ok(logLinesOf(again).every((line) => (line.level ?? 0) < 50), "the second load logged no error");
    });
  });

}

// After E2E-26, which asks what changed since T1 before anything has.
export function registerFeedChanges(): void {
  scenario("E2E-22", "A changed listing updates its experience", async ({ c, logs }) => {
    const startedAt = new Date().toISOString();
    const before = await versions();
    edit(
      "benguela-cove",
      "dancing-queen-ultimate-abba-experience.txt",
      (entry) => {
        entry.status = "cancelled";
        entry.booking = "closed";
      },
      (text) => `${text}\nCANCELLED: this show has been called off by the organisers. Tickets will be refunded.\n`,
    );
    edit(
      "benguela-cove",
      "andrew-young-live-concert.txt",
      (entry) => {
        entry.status = "postponed";
        entry.booking = "closed";
      },
      (text) => `${text}\nPOSTPONED: this concert is postponed. A new date will be announced.\n`,
    );
    edit(
      "benguela-cove",
      "that-80s-show-concert.txt",
      (entry) => {
        for (const session of entry.sessions) {
          if (session.start === "2027-02-27") {
            session.start = "2027-03-06";
            if (session.end === "2027-02-27") session.end = "2027-03-06";
          }
        }
      },
      (text) => text.replaceAll("27 February 2027", "6 March 2027"),
    );
    edit(
      "benguela-cove",
      "christmas-eve-dinner-2026.txt",
      (entry) => {
        entry.price = { min: 650, max: 650, currency: "ZAR" };
      },
      (text) => `${text}\nR650 per person.\n`,
    );
    edit(
      "race2hermanus",
      "home.txt",
      (entry) => {
        entry.status = "confirmed";
        entry.booking = "open";
        entry.bookingUrl = "https://r2h.bikeruntri.co.za/enter";
      },
      (text) => `${text}\nEntries are now open. Enter at https://r2h.bikeruntri.co.za/enter\n`,
    );

    const benguela = await captures(["--source", "benguela-cove"]);
    const race = await captures(["--source", "race2hermanus"]);
    logs(async (lc) => {
      const lines = [...logLinesOf(benguela), ...logLinesOf(race)];
      const changed = lines.filter((line) => line.msg === "Experience changed");
      lc.ok(changed.length >= 5, `each experience changed is logged with its change (${changed.length})`);
      lc.ok(changed.every((line) => typeof line.experienceId === "string" && typeof line.change === "string"), "a change's line names the experience and the kind");
      await checkDomainEvents(lc, [benguela, race], startedAt);
    });
    checkNoFailure(c, benguela, "The Benguela Cove load");
    checkNoFailure(c, race, "The Race2Hermanus load");
    const cove = sourceLine(benguela, "Benguela Cove");
    c.ok(cove?.newOrChanged === 4, `Benguela Cove reports the 4 edited pages as changed: ${show(cove)}`);
    const triathlon = sourceLine(race, "Race2Hermanus triathlon");
    c.ok(triathlon?.newOrChanged === 1, `Race2Hermanus reports its page as changed: ${show(triathlon)}`);

    const after = await versions();
    c.equal(after.length, before.length, "no new experience was created");
    const expected: Record<string, string> = {
      "Dancing Queen: The Ultimate ABBA Experience": "cancelled",
      "Andrew Young Live Concert": "postponed",
      "That ’80s Show: 80s Tribute Concert": "",
      "Christmas Eve Dinner 2026 at Moody Lagoon": "",
      "Race2Hermanus Triathlon 2027": "confirmed",
    };
    for (const [title, status] of Object.entries(expected)) {
      const was = before.find((one) => one.title === title);
      const now = after.find((one) => one.title === title);
      if (!c.ok(was !== undefined && now !== undefined, `"${title}" is there before and after`) || !was || !now) continue;
      c.ok(now.version === was.version + 1, `"${title}" went from version ${was.version} to ${now.version}`);
      if (status !== "") c.equal(now.status, status, `"${title}" status`);
    }
    const others = after.filter((one) => !(one.title in expected) && before.find((was) => was.id === one.id)?.version !== one.version);
    c.equal(others.map((one) => one.title), [], "other experiences with a new version");
    remember("E2E-22 versions", after);

    const andrew = titled(await searchAll({ location: "hermanus", from: "2027-01-09", to: "2027-01-09" }), "Andrew Young Live Concert")[0];
    c.ok(andrew?.status === "postponed" && andrew.booking === "closed", `Andrew Young shows postponed and closed: ${show(andrew?.status)}`);
    const eighties = titled(await searchAll({ location: "hermanus", from: "2026-12-01", to: "2027-03-31" }), "That ’80s Show: 80s Tribute Concert")[0];
    c.equal(eighties ? sessionDays(eighties) : [], ["2026-12-12", "2027-03-06"], "the 80s show's dates");
    const dinner = titled(await searchAll({ location: "hermanus", from: "2026-12-24", to: "2026-12-24" }), "Christmas Eve Dinner 2026 at Moody Lagoon")[0];
    c.equal(dinner ? [dinner.price.min, dinner.price.max, dinner.price.currency] : [], [650, 650, "ZAR"], "the Christmas Eve dinner's price");
    const r2h = titled(await searchAll({ location: "hermanus", from: "2027-05-02", to: "2027-05-02" }), "Race2Hermanus Triathlon 2027")[0];
    c.ok(r2h?.status === "confirmed" && r2h.booking === "open" && r2h.bookable, `the triathlon is confirmed, open and bookable: ${show(r2h?.status)}`);
    c.ok(r2h?.bookingUrl === "https://r2h.bikeruntri.co.za/enter", `the triathlon's booking link: ${show(r2h?.bookingUrl)}`);
  });

  scenario("E2E-23", "A listing that disappears leads to Removed", async ({ c }) => {
    rmSync(join(state.capturesDir, "raw/benguela-cove/swallow-series-wine-tasting-lunch-events.txt"));
    const title = "Swallow Series Wine Tasting Lunches";
    const range = { location: "hermanus", from: "2026-12-01", to: "2027-09-30" };
    for (const round of [1, 2, 3]) {
      const load = await captures(["--source", "benguela-cove"]);
      checkNoFailure(c, load, `Load ${round}`);
      if (round === 2) c.ok(titled(await searchAll(range), title).length === 1, "after the second load it is still returned");
    }
    c.ok(titled(await searchAll(range), title).length === 0, "after the third load it is not returned");
    const stored = await query<{ status: string }>(state.dbUrl, `select status::text as status from experience where title = ${literal(title)}`);
    c.equal(stored.map((one) => one.status), ["removed"], "its status");
  });

  scenario("E2E-24", "One experience across many sources", async ({ c }) => {
    const cases: [string, string, string, number][] = [
      ["2026-12-11", "Fleetwood Mac", "Rumours of Fleetwood Mac Tribute at Hermanus Golf Club 11 Dec 2026", 6],
      ["2026-11-28", "Rosoberry", "Rosoberry Harvest Fest 2026", 8],
    ];
    for (const [day, text, title, sources] of cases) {
      const items = await searchAll({ location: "hermanus", from: day, to: day, query: text });
      c.equal(titled(items, title).length, 1, `"${title}" returned`);
      const lookalikes = items.filter((item) => item.title !== title && item.title.toLowerCase().includes(text.toLowerCase()));
      c.equal(lookalikes.map((item) => item.title), [], `other items named like "${text}"`);
      // The document counts the listings it was read from, on four sites for the concert.
      const linked = await one<{ listings: number; sites: number }>(
        state.dbUrl,
        `select count(distinct l.id)::int as listings, count(distinct l.source_id)::int as sites from experience e
           join experience_source_link k on k.experience_id = e.id join listing l on l.id = k.listing_id
          where e.title = ${literal(title)}`,
      );
      c.equal(linked.listings, sources, `"${title}" is one experience of this many listings`);
      c.note(`"${title}": ${linked.listings} listings on ${linked.sites} sources.`);
    }
  });

  scenario("E2E-25", "The operator fetches again and processes again", async ({ c, logs }) => {
    const none = await pipeline(["reprocess"]);
    c.ok(none.code !== 0, "reprocess with no selector exits with an error");
    c.ok(/exactly one of --listing, --experience, --source(,| and) --location/.test(none.output), `it names the four selectors: ${none.output.trim().slice(0, 200)}`);

    const festival = titled(await searchAll(WINTER), "2027 Hermanus FynArts Festival")[0];
    const before = await versions();
    if (c.ok(festival !== undefined, "search returns the FynArts Festival") && festival) {
      const sent = await pipeline(["reprocess", "--experience", festival.slug]);
      const count = Number((/Sent (\d+) listings back/.exec(sent.stdout) ?? [])[1] ?? "0");
      c.ok(sent.code === 0 && count > 0, `the experience reprocess sends its listings back: ${sent.stdout.trim().slice(0, 200)}`);
      const processed = await captures(["--source", "hermanus-fynarts"]);
      checkNoFailure(c, processed, "Processing the FynArts listings");
      const now = titled(await searchAll(WINTER), "2027 Hermanus FynArts Festival");
      c.equal(ids(now), [festival.id], "the FynArts Festival keeps its ID, and there is one");
      c.equal(now[0]?.version, festival.version, "its version, with no field changed");
      logs((lc) => {
        lc.ok(logLinesOf(sent).some((line) => line.msg === "Listings sent back for processing"), "the reprocess is logged");
      });
    }
    const quicket = await pipeline(["reprocess", "--source", "Quicket event pages"]);
    const requeued = Number((/Sent (\d+) listings back/.exec(quicket.stdout) ?? [])[1] ?? "0");
    const listings = await one<{ n: number }>(
      state.dbUrl,
      "select count(*)::int as n from listing l join source s on s.id = l.source_id where s.name = 'Quicket event pages'",
    );
    c.equal(requeued, listings.n, "the source reprocess sends every listing of the source back");
    const reloaded = await captures(["--source", "quicket"]);
    checkNoFailure(c, reloaded, "Processing the Quicket listings");
    const after = await versions();
    c.equal(after.length, before.length, "processing them created no experience");
    c.equal(after.filter((one) => before.find((was) => was.id === one.id)?.version !== one.version).map((one) => one.title), [], "experiences with a new version");
    const pending = await one<{ n: number }>(state.dbUrl, "select count(*)::int as n from raw_listing where status <> 'processed'");
    c.equal(pending.n, 0, "raw listings left unprocessed");
    c.note("The suite processes the listings sent back with the captures command, which answers from the captured files; pipeline process and --now need the language model and run with pnpm e2e:live.");
    if (state.live) {
      const { liveRefetch } = await import("./live.ts");
      await liveRefetch(c);
    } else {
      c.note("pipeline refetch fetches live sites: it runs with pnpm e2e:live.");
    }
  });
}

function ids(items: { id: string }[]): string[] {
  return items.map((item) => item.id);
}

