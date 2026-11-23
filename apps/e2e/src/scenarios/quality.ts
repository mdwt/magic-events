import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { show } from "../harness/checks.ts";
import { query } from "../harness/db.ts";
import { addMonths, hhmm, searchAll, today, type Experience, type Session } from "../harness/feed.ts";
import { ROOT } from "../harness/process.ts";
import { scenario } from "../harness/scenario.ts";
import { state } from "../harness/state.ts";

// Quality of the answers: E2E-42, a sample checked field by field against the captured files, and E2E-43, the
// "nothing false in the feed" checks that can be computed over the whole feed.

interface Entry {
  rawFile: string;
  url: string;
  source: string;
  title: string;
  type: string;
  status: string;
  booking: string;
  sessions: { start: string; end?: string | null; precision: string; startTime?: string | null; endTime?: string | null; cancelled?: boolean | null }[];
  recurrence?: { rule: string; start: string; end?: string | null; startTime?: string | null; skipped?: string[] | null } | null;
  venue?: { name?: string | null; city?: string | null } | null;
  price?: { min?: number | null; max?: number | null; currency?: string | null } | null;
  attributes?: Record<string, unknown> | null;
  tags?: string[] | null;
}

interface Link {
  id: string;
  source: string;
  url: string | null;
}

// Every captured experience, with the address of the page it was read from, from the run's own copy.
function capturedEntries(): Entry[] {
  const dir = state.capturesDir;
  const entries: Entry[] = [];
  for (const file of readdirSync(join(dir, "extracted"))) {
    if (!file.endsWith(".json")) continue;
    const source = file.replace(/\.json$/, "");
    const list = JSON.parse(readFileSync(join(dir, "extracted", file), "utf8")) as Omit<Entry, "url" | "source">[];
    for (const entry of list) {
      const path = join(dir, entry.rawFile);
      if (!existsSync(path)) continue;
      const url = /^URL:\s*(\S+)/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
      entries.push({ ...entry, url, source });
    }
  }
  return entries;
}

const MONTHS = "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec";
const NOISE = new Set([...MONTHS.split(" "), "the", "a", "an", "at", "in", "of", "and", "presents", "live"]);

function words(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !NOISE.has(word) && !/^\d+$/.test(word));
}

function sameTitle(a: string, b: string): boolean {
  const x = words(a).join(" ");
  const y = words(b).join(" ");
  return x === y || (x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x)));
}

function likeness(a: string, b: string): number {
  const x = new Set(words(a));
  const shared = words(b).filter((word) => x.has(word)).length;
  return shared / Math.max(1, Math.min(x.size, words(b).length));
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function weekday(day: string): string {
  return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? "";
}

function inWindow(start: string, end: string): boolean {
  return end >= today() && start <= addMonths(today(), 24);
}

// Whether the feed's sessions are the source's: each on a day the source gives, none the source gives missing.
function datesMatch(item: Experience, entry: Entry): boolean {
  if (entry.recurrence) {
    const rule = entry.recurrence;
    const days = /BYDAY=([A-Z,]+)/.exec(rule.rule)?.[1]?.split(",") ?? [];
    return item.sessions.every(
      (session) =>
        session.startDate >= rule.start &&
        (rule.end === null || rule.end === undefined || rule.end === "" || session.startDate <= rule.end) &&
        (days.length === 0 || days.includes(weekday(session.startDate))) &&
        !(rule.skipped ?? []).includes(session.startDate) &&
        (rule.startTime === null || rule.startTime === undefined || rule.startTime === "" || hhmm(session.startTime) === rule.startTime.slice(0, 5)),
    );
  }
  const theirs = entry.sessions
    .filter((session) => session.cancelled !== true)
    .map((session) => ({ start: session.start, end: session.end ?? session.start, precision: session.precision, time: session.startTime ?? null }))
    .map((session) => (session.precision === "month" ? { ...session, start: session.start.slice(0, 7), end: session.end.slice(0, 7) } : session));
  const key = (session: Session) =>
    session.precision === "month"
      ? { start: session.startDate.slice(0, 7), end: session.endDate.slice(0, 7), precision: "month" }
      : { start: session.startDate, end: session.endDate, precision: session.precision };
  const mine = item.sessions.map(key);
  const everyMineListed = mine.every((one) => theirs.some((other) => other.start === one.start && other.end === one.end && other.precision === one.precision));
  const noneMissing = theirs
    .filter((other) => other.precision !== "day" || inWindow(other.start, other.end))
    .filter((other) => other.precision === "day")
    .every((other) => mine.some((one) => one.start === other.start && one.end === other.end));
  const timesMatch = item.sessions.every((session) => {
    const other = entry.sessions.find((one) => one.start === session.startDate);
    return other === undefined || !other.startTime || hhmm(session.startTime) === other.startTime.slice(0, 5);
  });
  return everyMineListed && noneMissing && timesMatch;
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

function asSet(values: unknown): string[] {
  return (Array.isArray(values) ? values : values === undefined || values === null ? [] : [values]).map(String).sort();
}

interface Verdict {
  title: boolean;
  dates: boolean;
  status: boolean;
  venue: boolean;
  price: boolean;
  classes: boolean;
  notes: string[];
}

function judge(item: Experience, entries: Entry[], seasons: Set<string>): Verdict {
  const any = (test: (entry: Entry) => boolean) => entries.some(test);
  const first = entries[0];
  const verdict: Verdict = {
    title: any((entry) => sameTitle(item.title, entry.title)),
    dates: any((entry) => datesMatch(item, entry)),
    status: any((entry) => entry.status === item.status && entry.booking === item.booking),
    venue: any((entry) => same(entry.venue?.name, item.venue.name) && same(entry.venue?.city, item.venue.city)),
    price: any(
      (entry) =>
        (entry.price?.min ?? null) === item.price.min && (entry.price?.max ?? null) === item.price.max && same(entry.price?.currency, item.price.currency),
    ),
    classes: any((entry) => {
      const categories = asSet(entry.attributes?.category);
      const tags = asSet(entry.tags);
      const feedTags = item.tags.filter((tag) => !seasons.has(tag)).sort();
      return show(categories) === show(asSet(item.attributes.category)) && show(tags) === show(feedTags);
    }),
    notes: [],
  };
  const fields: [keyof Omit<Verdict, "notes">, string, string][] = [
    ["title", item.title, first?.title ?? ""],
    ["dates", show(item.sessions.map((s) => [s.startDate, s.endDate, s.precision, s.startTime])), show(first?.recurrence ?? first?.sessions)],
    ["status", `${item.status}/${item.booking}`, `${first?.status ?? ""}/${first?.booking ?? ""}`],
    ["venue", `${item.venue.name ?? ""}, ${item.venue.city ?? ""}`, `${first?.venue?.name ?? ""}, ${first?.venue?.city ?? ""}`],
    ["price", show(item.price), show(first?.price)],
    ["classes", show([item.attributes.category, item.tags]), show([first?.attributes?.category, first?.tags])],
  ];
  for (const [field, feed, source] of fields) {
    if (!verdict[field]) verdict.notes.push(`"${item.title}" ${field}: the feed says ${feed}, the source ${source}`);
  }
  return verdict;
}

// The captured entries an experience was built from: those on its listings' pages that name it.
function entriesOf(item: Experience, links: Link[], entries: Entry[]): Entry[] {
  const urls = new Set(links.filter((link) => link.id === item.id).map((link) => link.url));
  const onPages = entries.filter((entry) => urls.has(entry.url));
  const named = onPages.filter((entry) => sameTitle(item.title, entry.title));
  if (named.length > 0) return named;
  const best = Math.max(0, ...onPages.map((entry) => likeness(item.title, entry.title)));
  return onPages.filter((entry) => best > 0 && likeness(item.title, entry.title) === best);
}

// A small, seeded random, so a run draws the same sample from the same feed.
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AFRIKAANS = /\b(die|en|vir|van|met|word|ons|jy|kinders|kom|gaan)\b/gi;

async function theFeed(): Promise<{ items: Experience[]; links: Link[]; entries: Entry[]; seasons: Set<string> }> {
  const items = await searchAll({ location: "hermanus", from: today(), to: addMonths(today(), 24), radiusKm: 60 });
  const links = await query<Link>(
    state.dbUrl,
    `select k.experience_id as id, s.name as source, l.url from experience_source_link k
       join listing l on l.id = k.listing_id join source s on s.id = l.source_id`,
  );
  const seasons = new Set((await query<{ slug: string }>(state.dbUrl, "select slug from season")).map((one) => one.slug));
  return { items, links, entries: capturedEntries(), seasons };
}

export function registerQuality(): void {
  scenario("E2E-42", "A sample of answers matches the sources", async ({ c }) => {
    const { items, links, entries, seasons } = await theFeed();
    const sourcesOf = (item: Experience) => links.filter((link) => link.id === item.id);
    const afrikaans = (item: Experience) =>
      entriesOf(item, links, entries).some((entry) => {
        const text = readFileSync(join(state.capturesDir, entry.rawFile), "utf8");
        return (text.match(AFRIKAANS) ?? []).length > 40;
      });
    const groups: [string, number, (item: Experience) => boolean][] = [
      ["recurring", 3, (item) => item.type === "recurring"],
      ["runs", 3, (item) => item.type === "run"],
      ["on one day", 3, (item) => item.type === "single" && item.sessions.every((s) => s.startDate === s.endDate && s.precision === "day")],
      ["several days in a row", 2, (item) => item.type === "single" && item.sessions.some((s) => s.precision === "day" && s.startDate < s.endDate)],
      ["month precision", 2, (item) => item.sessions.some((s) => s.precision === "month")],
      ["three sources or more", 5, (item) => new Set(sourcesOf(item).map((link) => link.source)).size >= 3],
      ["bookable", 5, (item) => item.bookable],
      ["from Quicket", 3, (item) => sourcesOf(item).some((link) => /quicket/i.test(link.source))],
      ["from the Whale Coast PDF calendars", 2, (item) => sourcesOf(item).some((link) => /whale coast .*calendar/i.test(link.source))],
      ["from a page in Afrikaans", 2, afrikaans],
    ];
    const draw = random(20261123);
    const pool = [...items].sort(() => draw() - 0.5);
    const sample: Experience[] = [];
    const short = () => groups.filter(([, need, test]) => sample.filter(test).length < need);
    while (sample.length < 20) {
      const open = short();
      const candidates = pool.filter((item) => !sample.includes(item));
      if (candidates.length === 0) break;
      const score = (item: Experience) => open.filter(([, , test]) => test(item)).length;
      const best = Math.max(...candidates.map(score));
      const pick = candidates.find((item) => score(item) === best);
      if (pick === undefined) break;
      sample.push(pick);
    }
    for (const [name, need, test] of short()) {
      c.fail(`The sample has ${sample.filter(test).length} ${name}, of ${need}: the feed has ${items.filter(test).length}`);
    }
    for (const title of [
      "Rumours of Fleetwood Mac Tribute at Hermanus Golf Club 11 Dec 2026",
      "Swallow Series Wine Tasting Lunches",
      "Sourdough Baking Class",
      "Where the Wild Things Come to Rest: Carol Bryant Wildlife Sculpture Exhibition",
      "Kalfiefees Hermanus Kunstefees 2027",
      "Hermanus Country Market",
      "Hermanus Country Market Summer Night Markets",
    ]) {
      const named = items.find((item) => item.title === title);
      if (named !== undefined && !sample.includes(named)) sample.push(named);
    }
    const tally = { title: 0, dates: 0, status: 0, venue: 0, price: 0, classes: 0 };
    for (const item of sample) {
      const mine = entriesOf(item, links, entries);
      if (mine.length === 0) {
        c.fail(`"${item.title}" has no captured page: it is checked against the live source by hand`);
        continue;
      }
      const verdict = judge(item, mine, seasons);
      for (const field of Object.keys(tally) as (keyof typeof tally)[]) if (verdict[field]) tally[field] += 1;
      for (const note of verdict.notes) c.note(note);
    }
    const n = sample.length;
    for (const field of ["title", "dates", "status"] as const) c.ok(tally[field] === n, `${field} match on ${tally[field]} of ${n}`);
    for (const field of ["venue", "price", "classes"] as const) c.ok(tally[field] >= n - 2, `${field} match on ${tally[field]} of ${n}`);
    c.note(`Sample of ${n}: ${show(tally)}. The live pages, where a capture is older than the source, are checked by hand.`);
  });

  scenario("E2E-43", "Nothing false in the feed", async ({ c }) => {
    const { items, links, entries } = await theFeed();
    const coverage = /\| Location \| (.+) \|/.exec(readFileSync(join(ROOT, "docs/sources.md"), "utf8"))?.[1] ?? "";
    const towns = coverage
      .replace(/^Hermanus, with the surrounding Overstrand: /, "Hermanus, ")
      .split(",")
      .map((town) => town.trim().toLowerCase())
      .filter(Boolean);
    const far = /cape town|johannesburg|sandton|pretoria|durban|stellenbosch|paarl|franschhoek|somerset west|george|knysna/i;
    const elsewhere = new Set<string>();
    const seen = new Map<string, string>();
    const names = new Set((await query<{ name: string }>(state.dbUrl, "select name from season")).map((one) => one.name.toLowerCase()));
    const placeWords = new Set(towns.flatMap((town) => words(town)));
    const generic = new Set(["time", "event", "events", "calendar", "programme", "program", "tickets", "whats", "what", "on", "s"]);
    for (const item of items) {
      c.ok(item.sessions.some((session) => session.endDate >= today()), `"${item.title}" is over`);
      const city = `${item.venue.city ?? ""} ${item.venue.address ?? ""}`;
      if (far.test(city)) c.fail(`"${item.title}" is outside the area: ${city.trim()}`);
      else if (item.venue.city && !towns.some((town) => item.venue.city?.toLowerCase().includes(town))) elsewhere.add(item.venue.city);
      const key = words(item.title).join(" ");
      const twin = seen.get(key);
      if (twin !== undefined) c.fail(`"${item.title}" is there twice (also "${twin}")`);
      seen.set(key, item.title);
      if (names.has(item.title.toLowerCase()) || /^southern right whales/i.test(item.title)) c.fail(`"${item.title}" is a season, not an experience`);
      const left = words(item.title).filter((word) => !placeWords.has(word) && !generic.has(word));
      if (left.length === 0) c.fail(`"${item.title}" names no experience`);
      if (item.bookable) c.ok(Boolean(item.bookingUrl ?? item.pageUrl), `"${item.title}" is bookable with no link to book through`);
      if (links.some((link) => link.id === item.id && /quicket/i.test(link.source))) {
        const quicket = entriesOf(item, links, entries).filter((entry) => entry.source === "quicket");
        if (quicket.length > 0 && !quicket.some((entry) => datesMatch(item, entry))) {
          c.fail(`"${item.title}" from Quicket covers days its page does not list: ${show(item.sessions.map((s) => [s.startDate, s.endDate]))}`);
        }
      }
    }
    if (elsewhere.size > 0) c.note(`Venues in towns not named under Coverage in sources.md, to check by hand: ${[...elsewhere].sort().join(", ")}`);
    c.note(`Checked ${items.length} items. Whether an item is one item of a festival's programme is checked by hand.`);
  });
}
