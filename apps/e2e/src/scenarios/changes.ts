import { isDeepStrictEqual } from "node:util";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import {
  changes,
  DECEMBER,
  FIELD_ORDER,
  search,
  searchAll,
  sessionKeys,
  titled,
  today,
  type Body,
  type Change,
  type ChangeItem,
  type Experience,
  type Session,
} from "../harness/feed.ts";
import { connect } from "../harness/mcp.ts";
import { scenario } from "../harness/scenario.ts";
import { LEVEL } from "../harness/server.ts";
import { client, mainServer, recall } from "../harness/state.ts";

// Checking back later (UC2): E2E-26 to E2E-30, after the loads of E2E-21 to E2E-23.

function since(c: Checks): string {
  const t1 = recall<string>("T1");
  if (t1 === undefined) c.fail("T1 was not recorded: E2E-21 did not run");
  return t1 ?? new Date().toISOString();
}

// Every changed experience, page after page.
async function allChanges(body: Body): Promise<ChangeItem[]> {
  const items: ChangeItem[] = [];
  for (let offset = 0; ; offset += 100) {
    const { result } = await changes({ ...body, limit: 100, offset });
    items.push(...result.items);
    if (result.items.length < 100 || items.length >= result.total) return items;
  }
}

function kinds(items: ChangeItem[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.experience.title, item.change.kind]));
}

const E2E_27: Body = { location: "hermanus", from: "2026-12-01", to: "2027-05-31" };

// The fields a change must name, and what they were before, from the experience as it was before E2E-22 and as it is
// now. Sessions are the ones it had inside the dates asked for.
function expectedChange(before: Experience, now: Experience, from: string, to: string): { fields: string[]; previous: Record<string, unknown> } {
  const inDates = (sessions: Session[]) => sessions.filter((s) => s.startDate <= to && s.endDate >= from);
  const compared: Record<string, [unknown, unknown]> = {
    status: [before.status, now.status],
    booking: [before.booking, now.booking],
    sessions: [sessionKeys(inDates(before.sessions)), sessionKeys(inDates(now.sessions))],
    price: [before.price, now.price],
    bookingUrl: [before.bookingUrl, now.bookingUrl],
    pageUrl: [before.pageUrl, now.pageUrl],
  };
  const fields = FIELD_ORDER.filter((field) => field in compared && !isDeepStrictEqual(compared[field]?.[0], compared[field]?.[1]));
  const previous: Record<string, unknown> = {};
  for (const field of fields) previous[field] = compared[field]?.[0];
  return { fields, previous };
}

// What a change's previous says, with sessions as their days and times.
function previousOf(change: Change): Record<string, unknown> {
  const previous: Record<string, unknown> = { ...(change.previous ?? {}) };
  if ("sessions" in previous) previous.sessions = sessionKeys(previous.sessions);
  return previous;
}

function checkDetail(c: Checks, item: ChangeItem, before: Experience | undefined, from: string, to: string): string {
  const title = item.experience.title;
  if (!c.ok(before !== undefined, `"${title}" was there before E2E-22`) || before === undefined) return "";
  const expected = expectedChange(before, item.experience, from, to);
  c.equal(item.change.fields, expected.fields, `"${title}" ${item.change.kind}: fields`);
  c.equal(previousOf(item.change), expected.previous, `"${title}" ${item.change.kind}: previous`);
  return `${title}: ${item.change.kind} ${item.change.fields.join("+")} was ${show(previousOf(item.change), 120)}`;
}

// Run straight after E2E-21, as its text says: E2E-22 changes the December stay.
export function registerNothingChanged(): void {
  scenario("E2E-26", "Nothing changed, nothing reported", async ({ c, logs }) => {
    const { call, result } = await changes({ ...DECEMBER, since: since(c) });
    c.equal([result.items.length, result.total], [0, 0], "items and total");
    c.saw(`December stay since T1: ${call.status}, ${result.items.length} items, total ${result.total}`);
    logs((lc) => {
      const lines = mainServer().lines().filter((line) => line.requestId === call.requestId);
      lc.ok(lines.some((line) => line.msg === "Finding changes" && line.level === LEVEL.debug), "the resolved changes query is logged at debug");
      lc.ok(lines.some((line) => line.msg === "Found changes" && typeof line.count === "number"), "the count of changes is logged");
    });
  });

}

export function registerChanges(): void {
  scenario("E2E-27", "What changed is reported, with what kind of change", async ({ c }) => {
    const items = await allChanges({ ...E2E_27, since: since(c) });
    c.equal(
      kinds(items),
      {
        "Dancing Queen: The Ultimate ABBA Experience": "cancelled",
        "Andrew Young Live Concert": "postponed",
        "That ’80s Show": "rescheduled",
        "Christmas Eve Dinner": "changed",
        "Race2Hermanus Triathlon": "confirmed",
        // E2E-23 removed it, after T1, and its dates are in the range.
        "Swallow Series Wine Tasting Lunches": "removed",
      },
      "the changed experiences and their kinds",
    );
    const five = [
      "Dancing Queen: The Ultimate ABBA Experience",
      "Andrew Young Live Concert",
      "That ’80s Show",
      "Christmas Eve Dinner",
      "Race2Hermanus Triathlon",
      "Swallow Series Wine Tasting Lunches",
    ];
    const others = items.filter((item) => !five.includes(item.experience.title));
    if (others.length > 0) c.note(`Reported beside the six: ${others.map((item) => `${item.experience.title} (${item.change.kind})`).join(", ")}`);
    const before = recall<Experience[]>("before E2E-22") ?? [];
    const details = items.map((item) => checkDetail(c, item, before.find((one) => one.id === item.experience.id), "2026-12-01", "2027-05-31"));
    for (const item of items) {
      const ats = item.changes.map((change) => change.at);
      c.ok(isDeepStrictEqual(ats, [...ats].sort().reverse()), `"${item.experience.title}" lists its changes newest first`);
    }
    const latest = items.map((item) => item.changes[0]?.at ?? item.change.at);
    c.ok(isDeepStrictEqual(latest, [...latest].sort().reverse()), "the most recent change comes first");
    const andrew = titled((await search({ location: "hermanus", from: "2027-01-09", to: "2027-01-09", limit: 100 })).result.items, "Andrew Young Live Concert")[0];
    c.ok(
      andrew?.status === "postponed" && andrew.booking === "closed" && !andrew.bookable,
      `the postponed concert is returned postponed, closed and not bookable: ${show(andrew && [andrew.status, andrew.booking, andrew.bookable])}`,
    );
    const r2h = titled((await search({ location: "hermanus", from: "2027-05-02", to: "2027-05-02", limit: 100 })).result.items, "Race2Hermanus Triathlon")[0];
    c.ok(r2h?.bookable === true, "the confirmed triathlon is bookable");
    const t0 = recall<string>("T0");
    if (t0 !== undefined) {
      const fresh = await allChanges({ ...DECEMBER, since: t0 });
      const december = await searchAll(DECEMBER);
      c.ok(fresh.length >= december.length, `since before the load, ${fresh.length} changes for ${december.length} experiences of the December stay`);
      for (const item of fresh) {
        c.ok(item.changes.some((change) => change.kind === "new"), `"${item.experience.title}" is not reported as new since before the load`);
        for (const change of item.changes.filter((one) => one.kind === "new")) {
          c.ok(change.fields.length === 0 && change.previous === null, `"${item.experience.title}": a new entry has no fields and no previous: ${show(change)}`);
        }
      }
      c.saw(
        `1 Dec 2026 to 31 May 2027 since T1: ${items.length} items: ${details.join("; ")}. ` +
          `Since before the load, December stay: ${fresh.length} items, each new with no fields and no previous`,
      );
    }
  });

  scenario("E2E-28", "Cancelled and removed are reported though search drops them", async ({ c }) => {
    const dropped = await searchAll({ location: "hermanus", from: "2027-01-30", to: "2027-01-30" });
    c.equal(titled(dropped, "Dancing Queen: The Ultimate ABBA Experience").length, 0, "search returns the cancelled show");
    const range = { location: "hermanus", from: "2026-12-01", to: "2027-09-30", since: since(c) };
    const reported: string[] = [];
    for (const body of [range, { ...range, bookable: true }, { ...range, status: ["confirmed"] }]) {
      const items = await allChanges(body);
      const what = show(body);
      const dancing = items.find((item) => item.experience.title === "Dancing Queen: The Ultimate ABBA Experience");
      c.ok(dancing?.change.kind === "cancelled" && dancing.experience.status === "cancelled", `${what}: the cancelled show is reported cancelled`);
      const swallow = items.find((item) => item.experience.title === "Swallow Series Wine Tasting Lunches");
      c.ok(swallow?.change.kind === "removed" && swallow.experience.status === "removed", `${what}: the Swallow Series is reported removed`);
      for (const item of items) {
        const last = item.experience.sessions.map((session) => session.endDate).sort().at(-1);
        c.ok(last === undefined || last >= today(), `${what}: "${item.experience.title}" is over`);
      }
      for (const [one, name] of [[dancing, "the cancelled show"], [swallow, "the Swallow Series"]] as const) {
        c.ok(one?.change.fields.includes("status") === true, `${what}: ${name}'s change names status: ${show(one?.change.fields)}`);
        c.equal(one?.change.previous?.status, "confirmed", `${what}: ${name}'s status before`);
      }
      reported.push(`${items.length} items, Dancing Queen ${dancing?.change.kind ?? "absent"} (was ${show(dancing?.change.previous)}), Swallow Series ${swallow?.change.kind ?? "absent"} (was ${show(swallow?.change.previous)})`);
    }
    c.saw(`search 30 Jan 2027: Dancing Queen not returned; changes since T1, plain, bookable true, status confirmed: ${reported.join(" | ")}`);
  });

  scenario("E2E-29", "Moved out of the dates searched", async ({ c }) => {
    const title = "That ’80s Show";
    const seen: string[] = [];
    for (const [from, to, movedOut] of [["2027-02-20", "2027-02-28", true], ["2027-03-01", "2027-03-10", false]] as const) {
      const items = await allChanges({ location: "hermanus", from, to, since: since(c) });
      const show80s = items.find((item) => item.experience.title === title);
      c.ok(show80s?.change.kind === "rescheduled", `${from} to ${to}: the 80s show is reported rescheduled (${show(show80s?.change)})`);
      c.equal(show80s?.movedOut, movedOut, `${from} to ${to}: movedOut`);
      c.equal(show80s?.change.fields, ["sessions"], `${from} to ${to}: the change's fields`);
      // What it was on during these dates before it moved: the 27 February show, or nothing in March.
      c.equal(sessionKeys(show80s?.change.previous?.sessions), movedOut ? ["2027-02-27..2027-02-27 19:30"] : [], `${from} to ${to}: its sessions before`);
      seen.push(
        `${from} to ${to}: ${show80s?.change.kind ?? "absent"}, movedOut ${String(show80s?.movedOut)}, sessions now ${show80s ? show80s.experience.sessions.map((s) => s.startDate).join(", ") : ""}, before ${show(sessionKeys(show80s?.change.previous?.sessions))}`,
      );
    }
    c.saw(`"${title}" since T1: ${seen.join(" | ")}`);
  });

  scenario("E2E-30", "Checking back through MCP", async ({ c, logs }) => {
    const session = await connect(mainServer(), client("agency agent"));
    try {
      const body = { ...E2E_27, since: since(c) };
      const answer = await session.callTool("get_experience_changes", body);
      const rest = await changes(body);
      c.ok(!answer.isError, `get_experience_changes is not an error: ${answer.text.slice(0, 200)}`);
      c.ok(isDeepStrictEqual(answer.structuredContent, rest.result), "structuredContent equals the REST answer");
      const viaMcp = (answer.structuredContent as { items?: ChangeItem[] } | undefined)?.items ?? [];
      const dinner = viaMcp.find((item) => item.experience.title === "Christmas Eve Dinner");
      c.equal(dinner?.change.fields, ["price"], "over MCP the price change names price");
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const refused = await session.callTool("get_experience_changes", { ...E2E_27, since: future });
      c.ok(refused.isError, "a since in the future is a tool error");
      let error: { error?: { code?: string; details?: { path: string }[] } } = {};
      try {
        error = JSON.parse(refused.text) as typeof error;
      } catch {
        c.fail(`the tool error's text is not JSON: ${refused.text.slice(0, 200)}`);
      }
      c.equal(error.error?.code, "invalid_input", "the tool error's code");
      c.ok(error.error?.details?.some((detail) => detail.path === "since") === true, `its details name since: ${show(error.error?.details)}`);
      c.saw(`get_experience_changes with E2E-27's arguments: ${String((answer.structuredContent as { total?: number } | undefined)?.total)} items, equal to REST, the price change with fields ${show(dinner?.change.fields)} and previous ${show(dinner?.change.previous)}; since an hour ahead: tool error ${String(error.error?.code)}, ${show(error.error?.details)}`);
      logs((lc) => {
        const lines = mainServer().lines().filter((line) => line.requestId === refused.call?.requestId);
        const line = lines.find((one) => one.msg === "Tool call refused");
        lc.ok(line?.level === LEVEL.warn && line.tool === "get_experience_changes", "the refused tool call is logged at warn with the tool");
      });
    } finally {
      await session.close();
    }
  });
}
