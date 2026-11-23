import { isDeepStrictEqual } from "node:util";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import { changes, DECEMBER, search, searchAll, titled, today, type Body, type ChangeItem } from "../harness/feed.ts";
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

// Run straight after E2E-21, as its text says: E2E-22 changes the December stay.
export function registerNothingChanged(): void {
  scenario("E2E-26", "Nothing changed, nothing reported", async ({ c, logs }) => {
    const { call, result } = await changes({ ...DECEMBER, since: since(c) });
    c.equal([result.items.length, result.total], [0, 0], "items and total");
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
        "That ’80s Show: 80s Tribute Concert": "rescheduled",
        "Christmas Eve Dinner 2026 at Moody Lagoon": "changed",
        "Race2Hermanus Triathlon 2027": "confirmed",
        // E2E-23 removed it, after T1, and its dates are in the range.
        "Swallow Series Wine Tasting Lunches": "removed",
      },
      "the changed experiences and their kinds",
    );
    const five = [
      "Dancing Queen: The Ultimate ABBA Experience",
      "Andrew Young Live Concert",
      "That ’80s Show: 80s Tribute Concert",
      "Christmas Eve Dinner 2026 at Moody Lagoon",
      "Race2Hermanus Triathlon 2027",
      "Swallow Series Wine Tasting Lunches",
    ];
    const others = items.filter((item) => !five.includes(item.experience.title));
    if (others.length > 0) c.note(`Reported beside the six: ${others.map((item) => `${item.experience.title} (${item.change.kind})`).join(", ")}`);
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
    const r2h = titled((await search({ location: "hermanus", from: "2027-05-02", to: "2027-05-02", limit: 100 })).result.items, "Race2Hermanus Triathlon 2027")[0];
    c.ok(r2h?.bookable === true, "the confirmed triathlon is bookable");
    const t0 = recall<string>("T0");
    if (t0 !== undefined) {
      const fresh = await allChanges({ ...DECEMBER, since: t0 });
      const december = await searchAll(DECEMBER);
      c.ok(fresh.length >= december.length, `since before the load, ${fresh.length} changes for ${december.length} experiences of the December stay`);
      for (const item of fresh) {
        c.ok(item.changes.some((change) => change.kind === "new"), `"${item.experience.title}" is not reported as new since before the load`);
      }
    }
  });

  scenario("E2E-28", "Cancelled and removed are reported though search drops them", async ({ c }) => {
    const dropped = await searchAll({ location: "hermanus", from: "2027-01-30", to: "2027-01-30" });
    c.equal(titled(dropped, "Dancing Queen: The Ultimate ABBA Experience").length, 0, "search returns the cancelled show");
    const range = { location: "hermanus", from: "2026-12-01", to: "2027-09-30", since: since(c) };
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
    }
  });

  scenario("E2E-29", "Moved out of the dates searched", async ({ c }) => {
    const title = "That ’80s Show: 80s Tribute Concert";
    for (const [from, to, movedOut] of [["2027-02-20", "2027-02-28", true], ["2027-03-01", "2027-03-10", false]] as const) {
      const items = await allChanges({ location: "hermanus", from, to, since: since(c) });
      const show80s = items.find((item) => item.experience.title === title);
      c.ok(show80s?.change.kind === "rescheduled", `${from} to ${to}: the 80s show is reported rescheduled (${show(show80s?.change)})`);
      c.equal(show80s?.movedOut, movedOut, `${from} to ${to}: movedOut`);
    }
  });

  scenario("E2E-30", "Checking back through MCP", async ({ c, logs }) => {
    const session = await connect(mainServer(), client("agency agent"));
    try {
      const body = { ...E2E_27, since: since(c) };
      const answer = await session.callTool("get_experience_changes", body);
      const rest = await changes(body);
      c.ok(!answer.isError, `get_experience_changes is not an error: ${answer.text.slice(0, 200)}`);
      c.ok(isDeepStrictEqual(answer.structuredContent, rest.result), "structuredContent equals the REST answer");
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
