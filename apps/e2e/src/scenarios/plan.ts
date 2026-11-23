import { isDeepStrictEqual } from "node:util";
import { errorOf, send, type Call } from "../harness/api.ts";
import type { Checks } from "../harness/checks.ts";
import { show } from "../harness/checks.ts";
import { query } from "../harness/db.ts";
import {
  addMonths,
  DECEMBER,
  distanceKm,
  hhmm,
  ids,
  overlaps,
  search,
  searchAll,
  sessionDays,
  titled,
  titles,
  today,
  WINTER,
  type Body,
  type Experience,
  type SearchResult,
} from "../harness/feed.ts";
import { connect, rpc } from "../harness/mcp.ts";
import { scenario, byHand } from "../harness/scenario.ts";
import { LEVEL } from "../harness/server.ts";
import { client, mainServer, recall, remember, state } from "../harness/state.ts";

// Planning a trip (UC1), each kind of experience in the brief, and the long planning window: E2E-01 to E2E-17.

const SEARCHABLE = ["expected", "announced", "confirmed", "postponed"];
const HERMANUS = { lat: -34.4187, lng: 19.2345 };

function one(c: Checks, items: Experience[], title: string): Experience | undefined {
  const found = titled(items, title);
  c.ok(found.length === 1, `"${title}" is there once (seen ${found.length} times)`);
  return found[0];
}

function absent(c: Checks, items: Experience[], title: string, where: string): void {
  c.ok(titled(items, title).length === 0, `"${title}" is not returned ${where}`);
}

function firstStart(item: Experience): string {
  return item.sessions.map((session) => session.startDate).sort()[0] ?? "";
}

// The order search gives with no query text, within each tier: by first session in the dates, then by title.
const TIERS = ["luxury", "premium", "standard", "everyday"];
export function tierOf(item: Experience): number {
  const value = item.attributes.tier?.[0];
  const index = typeof value === "string" ? TIERS.indexOf(value) : -1;
  return index === -1 ? TIERS.indexOf("standard") : index;
}

function checkDateOrderWithinTier(c: Checks, items: Experience[], what: string): void {
  for (let index = 1; index < items.length; index += 1) {
    const before = items[index - 1];
    const after = items[index];
    if (before === undefined || after === undefined) continue;
    if (tierOf(before) !== tierOf(after)) continue;
    if (firstStart(before) > firstStart(after)) {
      c.fail(`${what}: "${after.title}" (${firstStart(after)}) comes after "${before.title}" (${firstStart(before)})`);
      return;
    }
  }
}

function bookableAsBuilt(item: Experience): boolean {
  return item.status === "confirmed" && item.booking === "open" && Boolean(item.bookingUrl ?? item.pageUrl);
}

function searchLogs(c: Checks, call: Call): void {
  const lines = mainServer().lines().filter((line) => line.requestId === call.requestId);
  const resolved = lines.find((line) => line.msg === "Searching experiences");
  c.ok(resolved?.level === LEVEL.debug && resolved.query !== undefined, "the resolved query is logged at debug");
  const searched = lines.find((line) => line.msg === "Searched experiences");
  c.ok(
    searched?.level === LEVEL.info && typeof searched.count === "number" && typeof searched.durationMs === "number",
    "the search's count and duration are logged at info",
  );
}

export function registerPlanning(): void {
  scenario("E2E-01", "What is on while the traveller is there", async ({ c, logs }) => {
    const { call, result } = await search(WINTER);
    c.equal(result.total, 33, "total");
    const items = await searchAll(WINTER);
    remember("E2E-01", { total: result.total, items });
    for (const item of items) {
      c.ok(SEARCHABLE.includes(item.status), `"${item.title}" has status ${item.status}`);
      for (const session of item.sessions) {
        c.ok(overlaps(session, "2027-06-20", "2027-06-30"), `"${item.title}" has a session ${show(session)} outside the stay`);
      }
      c.ok(item.sessions.length > 0, `"${item.title}" has no session in the stay`);
      // As built: bookable also needs a link to book through (issue 55), which the document does not say yet.
      c.ok(item.bookable === bookableAsBuilt(item), `"${item.title}" bookable is ${String(item.bookable)}`);
      c.ok("pageUrl" in item, `"${item.title}" has no pageUrl field`);
    }
    checkDateOrderWithinTier(c, items, "date order within a tier");

    const festival = one(c, items, "2027 Hermanus FynArts Festival");
    if (festival) {
      c.equal([festival.status, festival.booking, festival.bookable], ["announced", "not_yet", false], "FynArts status, booking, bookable");
      c.equal(
        festival.sessions.map((s) => [s.startDate, s.endDate, s.precision]),
        [["2027-06-24", "2027-07-04", "day"]],
        "FynArts sessions",
      );
    }
    const sculpture = one(c, items, "Sculpture on the Cliffs");
    if (sculpture) {
      c.equal(
        sculpture.sessions.map((s) => [s.startDate.slice(0, 7), s.endDate.slice(0, 7), s.precision]),
        [["2026-06", "2027-06", "month"]],
        "Sculpture on the Cliffs sessions",
      );
    }
    const market = one(c, items, "Hermanus Country Market");
    if (market) {
      c.equal(
        market.sessions.map((s) => [s.startDate, hhmm(s.startTime), hhmm(s.endTime)]),
        [["2027-06-26", "09:00", "14:00"]],
        "Hermanus Country Market sessions",
      );
    }
    logs((lc) => {
      searchLogs(lc, call);
    });
  });

  scenario("E2E-02", "Only what suits their interests", async ({ c }) => {
    const art = await searchAll({ ...WINTER, attributes: { category: ["visual_arts"] } });
    c.equal(
      titles(art).sort(),
      ["2027 Hermanus FynArts Festival", "Akwaaba Market", "Hermanus Country Market", "Sculpture on the Cliffs"].sort(),
      "the visual arts experiences",
    );
    absent(c, art, "Hermanus parkrun", "for visual arts");
    for (const item of art) c.ok(item.attributes.category?.includes("visual_arts") === true, `"${item.title}" is not visual arts`);
    const whales = await searchAll({ ...WINTER, tags: ["whales"] });
    c.ok(titled(whales, "Hermanus Whale Cruises boat-based whale watching").length === 1, "the whale cruises are there");
    for (const item of whales) c.ok(item.tags.includes("whales"), `"${item.title}" does not carry whales`);
  });

  scenario("E2E-03", "A family with young children", async ({ c }) => {
    const app = client("app person");
    const family = await searchAll(
      { location: "hermanus", from: "2026-12-12", to: "2026-12-31", attributes: { audience: ["family", "all_ages"], minimum_age: { max: 10 } } },
      app,
    );
    for (const title of ["Paddakoor Akademie Presents - CHRISTMAS CARNIVAL", "New Years´s Eve Family Day at Landskein", "Hermanus Country Market"]) {
      c.ok(titled(family, title).length === 1, `"${title}" is there for the family`);
    }
    for (const item of family) {
      c.ok(item.attributes.audience?.includes("adults") !== true, `"${item.title}" has audience adults`);
      const age = item.attributes.minimum_age?.[0];
      c.ok(typeof age !== "number" || age <= 10, `"${item.title}" has minimum age ${String(age)}`);
    }
    absent(c, family, "Electro DANCE - Sunset Beats to Late Night Bass", "for the family");
    const adults = await searchAll({ location: "hermanus", from: "2026-12-12", to: "2026-12-31", attributes: { minimum_age: { min: 18 } } }, app);
    c.equal(titles(adults), ["Electro DANCE - Sunset Beats to Late Night Bass"], "the 18 and over answer");
    const electro = adults[0];
    // The night runs from 19:00 on the 16th to 01:00 on the 17th, which is one session starting on the 16th.
    if (electro) c.equal(electro.sessions.map((s) => s.startDate), ["2026-12-16"], "Electro DANCE sessions start");
  });

  scenario("E2E-04", "Only what can be booked now", async ({ c }) => {
    const items = await searchAll({ ...WINTER, bookable: true });
    for (const item of items) {
      c.ok(item.status === "confirmed" && item.booking === "open" && item.bookable, `"${item.title}" is not confirmed, open and bookable`);
    }
    c.equal(
      titles(items).sort(),
      [
        "Cape Shark Adventures",
        "Cuvée Weekends at Benguela Cove",
        "Deli Dining at Dal-Italia",
        "Harold Porter National Botanical Garden",
        "Hermanus Whale Cruises boat-based whale watching",
        "Panthera Africa Sunset Visits",
        "Shark Cage Diving & Surface Viewing- Gansbaai",
        "Sourdough Baking Class",
      ].sort(),
      "the bookable experiences",
    );
    absent(c, items, "2027 Hermanus FynArts Festival", "as bookable");
  });

  scenario("E2E-05", "By the place's name", async ({ c, logs }) => {
    const first = recall<{ total: number; items: Experience[] }>("E2E-01");
    const all = await searchAll(WINTER);
    if (first) c.equal(ids(all), ids(first.items), "the same answer as E2E-01");
    const refusals: [Body, string, RegExp | undefined][] = [
      [{ ...WINTER, location: "cape-agulhas" }, "location", /cape-agulhas/],
      [{ ...WINTER, near: HERMANUS }, "near", undefined],
      [{ from: "2027-06-20", to: "2027-06-30" }, "location", undefined],
    ];
    const refused: Call[] = [];
    for (const [body, path, names] of refusals) {
      const call = await send(mainServer(), { path: "/v1/experiences/search", client: client("agency person"), body });
      refused.push(call);
      const error = errorOf(call.json);
      c.ok(call.status === 400 && error?.code === "invalid_input", `${show(body)} is ${call.status} ${error?.code ?? ""}`);
      const detail = error?.details.find((one) => one.path === path);
      c.ok(detail !== undefined, `${show(body)} has a detail on ${path}: ${show(error?.details)}`);
      if (names && detail) c.ok(names.test(detail.message), `the detail on location names it: "${detail.message}"`);
    }
    logs((lc) => {
      for (const call of refused) {
        const line = mainServer().find((l) => l.requestId === call.requestId && l.msg === "Search refused");
        lc.ok(line?.level === LEVEL.warn, `the refused search ${call.requestId ?? ""} is logged at warn as "Search refused"`);
      }
    });
  });

  scenario("E2E-06", "Around a point, within a radius", async ({ c }) => {
    const first = recall<{ total: number; items: Experience[] }>("E2E-01");
    const around = await searchAll({ from: "2027-06-20", to: "2027-06-30", near: HERMANUS, radiusKm: 25 });
    // As built the default radius is 60 km, so E2E-01's answer reaches further than 25 km: the same search by the
    // location with the same radius is the one to compare with.
    const named = await searchAll({ ...WINTER, radiusKm: 25 });
    c.equal(ids(around), ids(named), "the same items in the same order as the winter stay by location, within 25 km");
    if (first) c.note(`Within 25 km: ${around.length} items; E2E-01, within the default 60 km: ${first.items.length}.`);
    for (const item of around) c.ok(typeof item.distanceKm === "number", `"${item.title}" has no distanceKm`);
    const tooFar = await send(mainServer(), {
      path: "/v1/experiences/search",
      client: client("agency person"),
      body: { from: "2027-06-20", to: "2027-06-30", near: HERMANUS, radiusKm: 201 },
    });
    const error = errorOf(tooFar.json);
    const detail = error?.details.find((one) => one.path === "radiusKm");
    c.ok(tooFar.status === 400 && error?.code === "invalid_input", `radius 201 is ${tooFar.status}`);
    c.ok(detail !== undefined && detail.message.includes("200"), `the detail on radiusKm gives the limit: ${show(error?.details)}`);

    const horizon = { from: today(), to: addMonths(today(), 24), near: HERMANUS, radiusKm: 60 };
    const wide = await searchAll(horizon);
    const placed = wide.filter((item) => item.venue.position !== null);
    const unplaced = wide.filter((item) => item.venue.position === null);
    c.ok(placed.length > 0, "some experience carries its venue's position");
    for (const item of placed) {
      const position = item.venue.position;
      if (position === null) continue;
      const real = distanceKm(HERMANUS, position);
      c.ok(Math.abs(real - item.distanceKm) < 0.5, `"${item.title}" is ${item.distanceKm} km away, but its position is ${real.toFixed(1)} km`);
    }
    for (const item of unplaced) c.ok(item.distanceKm < 0.5, `"${item.title}" has no position but is ${item.distanceKm} km away`);
    const stanford = placed.find((item) => /stanford/i.test(`${item.venue.city ?? ""} ${item.venue.address ?? ""}`));
    if (c.ok(stanford !== undefined, "an experience in Stanford carries its position") && stanford) {
      c.ok(stanford.distanceKm > 15 && stanford.distanceKm < 25, `"${stanford.title}" in Stanford is ${stanford.distanceKm} km away, not about 20`);
      const near = await searchAll({ ...horizon, radiusKm: 10 });
      c.ok(titled(near, stanford.title).length === 0, `"${stanford.title}" in Stanford is left out by a radius of 10`);
    }
  });

  scenario("E2E-07", "In the order the traveller would like", async ({ c, logs }) => {
    const first = recall<{ total: number; items: Experience[] }>("E2E-01");
    const expected = first ? ids(first.items).sort() : [];
    const started = performance.now();
    const quiet = await search({ ...WINTER, limit: 100, query: "sculpture and art galleries, quiet and outdoors" });
    const tookMs = performance.now() - started;
    c.equal(ids(quiet.result.items).sort(), expected, "the query only reorders: the same set as E2E-01");
    c.equal(quiet.result.total, first?.total, "the same total as E2E-01");
    // As built, results come most premium first and the query orders within a tier.
    const sculpture = titled(quiet.result.items, "Sculpture on the Cliffs")[0];
    const sameTier = sculpture === undefined ? [] : quiet.result.items.filter((item) => tierOf(item) === tierOf(sculpture));
    c.ok(
      titles(sameTier.slice(0, 3)).includes("Sculpture on the Cliffs"),
      `"Sculpture on the Cliffs" is in the first three of its tier: ${show(titles(sameTier.slice(0, 3)))}`,
    );
    const fynarts = await search({ ...WINTER, limit: 100, query: "FynArts" });
    c.equal(ids(fynarts.result.items).sort(), expected, "FynArts query: the same set as E2E-01");
    c.equal(fynarts.result.items[0]?.title, "2027 Hermanus FynArts Festival", "the first for FynArts");
    if (state.live) {
      c.note("The run with the embedding model unreachable is E2E-07 on the server without AWS_REGION, in the live run.");
    } else {
      c.ok(tookMs < 5_000 + 2_000, `with the embedding model unreachable the search took ${Math.round(tookMs)} ms`);
      c.note("This run has no AWS settings, so every query text was ordered by keyword alone: the third step is the first.");
    }
    logs((lc) => {
      const line = mainServer().find((l) => l.requestId === quiet.call.requestId && l.msg === "Searched experiences");
      lc.ok(line !== undefined && line.byMeaning === state.live, `the search logs byMeaning ${String(line?.byMeaning)}`);
      if (!state.live) {
        const fallback = mainServer().find((l) => l.requestId === quiet.call.requestId && /ranking by keyword alone/.test(String(l.msg)));
        lc.ok(fallback !== undefined, "the log says the search fell back to keyword alone, and why");
      }
    });
  });

  scenario("E2E-08", "Paging through a long answer", async ({ c }) => {
    const first = recall<{ total: number; items: Experience[] }>("E2E-01");
    const pages: SearchResult[] = [];
    for (const offset of [0, 10, 20, 30]) pages.push((await search({ ...WINTER, limit: 10, offset })).result);
    for (const page of pages) c.equal(page.total, 33, `total at offset ${page.offset}`);
    c.equal(pages.map((page) => page.items.length), [10, 10, 10, 3], "page sizes");
    const together = pages.flatMap((page) => ids(page.items));
    c.equal(new Set(together).size, together.length, "no experience is on two pages");
    if (first) c.equal(together, ids(first.items), "together they are E2E-01's items in its order");
  });

  scenario("E2E-09", "The same answer for an AI agent over MCP", async ({ c, logs }) => {
    const session = await connect(mainServer(), client("agency agent"));
    try {
      const tools = await session.listTools();
      c.equal(tools.map((tool) => tool.name).sort(), ["get_experience_changes", "search_experiences"], "the tools listed");
      for (const tool of tools) {
        c.ok((tool.description ?? "").length > 40, `${tool.name} has a description`);
        c.ok(typeof tool.inputSchema === "object" && tool.inputSchema !== null, `${tool.name} has an input schema`);
      }
      const initialize = await rpc(mainServer(), client("agency agent"), "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "magic-events-e2e", version: "1.0.0" },
      });
      const capabilities = (initialize.json as { result?: { capabilities?: { tools?: { listChanged?: boolean } } } } | undefined)?.result?.capabilities;
      c.equal(capabilities?.tools?.listChanged, false, "initialize declares tools.listChanged");
      const bodies: Body[] = [
        WINTER,
        { location: "hermanus", from: "2026-12-12", to: "2026-12-31", attributes: { audience: ["family", "all_ages"], minimum_age: { max: 10 } } },
        { location: "hermanus", from: "2026-12-12", to: "2026-12-31", attributes: { minimum_age: { min: 18 } } },
        { ...WINTER, query: "sculpture and art galleries, quiet and outdoors" },
        { ...WINTER, query: "FynArts" },
      ];
      const toolCalls: string[] = [];
      for (const body of bodies) {
        const answer = await session.callTool("search_experiences", body);
        if (answer.call?.requestId) toolCalls.push(answer.call.requestId);
        const rest = await search(body);
        c.ok(!answer.isError, `search_experiences ${show(body)} is not an error: ${answer.text.slice(0, 200)}`);
        c.ok(isDeepStrictEqual(answer.structuredContent, rest.result), `structuredContent equals the REST answer for ${show(body)}`);
      }
      remember("E2E-09 request", toolCalls[0]);
      logs((lc) => {
        for (const requestId of toolCalls) {
          const lines = mainServer().lines().filter((line) => line.requestId === requestId);
          const named = lines.find((line) => line.tool === "search_experiences");
          lc.ok(named !== undefined, `the log names the tool search_experiences for ${requestId}`);
          lc.ok(named?.callerKind === "agent", `the tool call's line says an agent called (${String(named?.callerKind)})`);
          const info = lines.find((line) => line.msg === "Tool called" && line.tool === "search_experiences");
          lc.ok(info?.level === LEVEL.info && info.arguments !== undefined, `the tool call is logged at info as "Tool called" with its arguments (${requestId})`);
        }
      });
    } finally {
      await session.close();
    }
  });

  byHand(
    "E2E-10",
    "A real AI agent plans the stay",
    "A person connects Claude to /mcp with the Agency Planner's agent key, asks the question, and reads the reply against the tool's answer and the log.",
  );

  scenario("E2E-11", "Something to go to on one date", async ({ c }) => {
    const items = await searchAll({ location: "hermanus", from: "2026-12-11", to: "2026-12-11" });
    const title = "Rumours of Fleetwood Mac Tribute at Hermanus Golf Club 11 Dec 2026";
    const show11 = one(c, items, title);
    if (show11) {
      c.equal([show11.status, show11.booking, show11.bookable], ["confirmed", "open", true], "status, booking, bookable");
      c.equal(show11.venue.name, "Hermanus Golf Club", "venue");
      c.equal([show11.price.min, show11.price.max, show11.price.currency], [430, 430, "ZAR"], "price");
      c.equal(
        show11.sessions.map((s) => [s.startDate, s.endDate, hhmm(s.startTime), hhmm(s.endTime)]),
        [["2026-12-11", "2026-12-11", "18:00", "22:30"]],
        "sessions",
      );
      c.ok(Boolean(show11.bookingUrl), "it has a booking link");
    }
    absent(c, await searchAll({ location: "hermanus", from: "2026-12-12", to: "2026-12-12" }), title, "on 12 December");
  });

  scenario("E2E-12", "Something that runs, only on its own dates", async ({ c }) => {
    const swallow = "Swallow Series Wine Tasting Lunches";
    absent(c, await searchAll({ location: "hermanus", from: "2026-12-06", to: "2027-01-08" }), swallow, "from 6 Dec to 8 Jan");
    const run = one(c, await searchAll({ location: "hermanus", from: "2026-12-01", to: "2027-01-10" }), swallow);
    if (run) c.equal(sessionDays(run), ["2026-12-05", "2027-01-09"], "the run's sessions from 1 Dec to 10 Jan");
    const sourdough = "Sourdough Baking Class";
    absent(c, await searchAll({ location: "hermanus", from: "2026-12-07", to: "2026-12-09" }), sourdough, "from Monday to Wednesday");
    const weekly = one(c, await searchAll({ location: "hermanus", from: "2026-12-07", to: "2026-12-10" }), sourdough);
    if (weekly) {
      c.equal(
        weekly.sessions.map((s) => [s.startDate, hhmm(s.startTime), hhmm(s.endTime)]),
        [["2026-12-10", "11:00", "15:00"]],
        "the class's sessions",
      );
    }
    const exhibition = one(
      c,
      await searchAll({ location: "hermanus", from: "2027-02-01", to: "2027-02-07" }),
      "Where the Wild Things Come to Rest: Carol Bryant Wildlife Sculpture Exhibition",
    );
    if (exhibition) c.equal(sessionDays(exhibition), ["2026-10-03..2027-03-31"], "the exhibition's session");
  });

  scenario("E2E-13", "Something months away, known only by its month", async ({ c }) => {
    const title = "Kalfiefees Hermanus Kunstefees 2027";
    const fees = one(c, await searchAll({ location: "hermanus", from: "2027-08-14", to: "2027-08-15" }), title);
    if (fees) {
      c.equal([fees.status, fees.bookable], ["expected", false], "status and bookable");
      c.equal(
        fees.sessions.map((s) => [s.startDate, s.endDate, s.precision, s.startTime, s.endTime]),
        [["2027-08-01", "2027-08-31", "month", null, null]],
        "the session",
      );
    }
    absent(c, await searchAll({ location: "hermanus", from: "2027-09-01", to: "2027-09-05" }), title, "in September");
    const festival = titled(recall<{ items: Experience[] }>("E2E-01")?.items ?? [], "2027 Hermanus FynArts Festival")[0];
    c.ok(festival?.sessions.every((s) => s.precision === "day") === true, "the FynArts Festival, whose days are announced, has day precision");
  });

  scenario("E2E-14", "A recurring market", async ({ c }) => {
    const app = client("app person");
    const december = await searchAll(DECEMBER, app);
    const market = one(c, december, "Hermanus Country Market");
    if (market) {
      c.equal(
        market.sessions.map((s) => [s.startDate, hhmm(s.startTime), hhmm(s.endTime)]),
        [["2026-12-12", "09:00", "14:00"], ["2026-12-19", "09:00", "14:00"]],
        "the Saturday market's sessions",
      );
    }
    const night = one(c, december, "Hermanus Country Market Summer Night Markets");
    if (night) {
      c.equal(
        night.sessions.map((s) => [s.startDate, hhmm(s.startTime), hhmm(s.endTime)]),
        [["2026-12-09", "17:00", "21:00"], ["2026-12-16", "17:00", "21:00"]],
        "the night markets' sessions",
      );
    }
    absent(c, await searchAll({ location: "hermanus", from: "2026-12-07", to: "2026-12-11" }, app), "Hermanus Country Market", "from Monday to Friday");
    absent(
      c,
      await searchAll({ location: "hermanus", from: "2027-02-01", to: "2027-02-14" }, app),
      "Hermanus Country Market Summer Night Markets",
      "in February",
    );
  });

  scenario("E2E-15", "Seasons are tags, never experiences", async ({ c }) => {
    const season = await searchAll({ ...WINTER, tags: ["whale-season"] });
    c.ok(titled(season, "2027 Hermanus FynArts Festival").length === 1, "the FynArts Festival is in whale season");
    const winter = await searchAll(WINTER);
    const tagsOf = (items: Experience[], title: string) => titled(items, title)[0]?.tags ?? [];
    const fynarts = tagsOf(winter, "2027 Hermanus FynArts Festival");
    c.ok(fynarts.includes("whale-season") && fynarts.includes("winter"), `FynArts carries whale-season and winter: ${show(fynarts)}`);
    const cruises = tagsOf(winter, "Hermanus Whale Cruises boat-based whale watching");
    c.ok(cruises.includes("whale-season") && cruises.includes("whales"), `the whale cruises carry whale-season and whales: ${show(cruises)}`);
    const dinner = tagsOf(await searchAll({ location: "hermanus", from: "2026-12-24", to: "2026-12-24" }), "Christmas Eve Dinner 2026 at Moody Lagoon");
    c.ok(
      ["summer", "high-season", "south-african-school-holidays"].every((tag) => dinner.includes(tag)) && !dinner.includes("whale-season"),
      `the Christmas Eve dinner carries summer, high-season and the school holidays, and not whale-season: ${show(dinner)}`,
    );
    const seasons = await query<{ slug: string; name: string }>(state.dbUrl, "select slug, name from season");
    const market = tagsOf(winter, "Hermanus Country Market");
    const marketSeasons = market.filter((tag) => seasons.some((one) => one.slug === tag));
    c.equal(marketSeasons, [], "the market that runs all year carries no season");
    const horizon = await searchAll({ location: "hermanus", from: today(), to: addMonths(today(), 24) });
    absent(c, horizon, "Southern Right Whales in Walker Bay", "as an experience");
    for (const one of seasons) absent(c, horizon, one.name, "as an experience: it is a season");
  });

  scenario("E2E-16", "Planning 6 to 18 months ahead", async ({ c }) => {
    const may = await searchAll({ location: "hermanus", from: "2028-05-01", to: "2028-05-14" });
    const market = one(c, may, "Hermanus Country Market");
    if (market) c.equal(sessionDays(market), ["2028-05-06", "2028-05-13"], "the market's Saturdays in May 2028");
    const september = await searchAll({ location: "hermanus", from: "2027-09-01", to: "2027-09-30" });
    // On the captured pages the one annual festival known only by its month next year is the Whale Festival, in
    // October. The development database also has the Flower and Eco Fair and Adventure Week, from seeded sources.
    const october = await searchAll({ location: "hermanus", from: "2027-10-01", to: "2027-10-31" });
    const festival = one(c, october, "Hermanus Whale Festival");
    if (festival) {
      c.ok(festival.status === "expected", `the Whale Festival is expected (${festival.status})`);
      c.equal(festival.sessions.map((s) => [s.startDate, s.endDate, s.precision]), [["2027-10-01", "2027-10-31", "month"]], "the Whale Festival's session");
    }
    const swallow = one(c, september, "Swallow Series Wine Tasting Lunches");
    if (swallow) c.equal(sessionDays(swallow), ["2027-09-04"], "the Swallow Series in September 2027");
    for (const item of [...september, ...october]) {
      if (item.status === "confirmed" && item.booking === "open") {
        c.ok(Boolean(item.bookingUrl ?? item.pageUrl), `"${item.title}" is confirmed with booking open and has nowhere to book`);
      }
    }
    c.note("Whether a source sells tickets now for a confirmed item that far ahead is checked by hand against the source.");
  });

  scenario("E2E-17", "Nothing beyond what is known", async ({ c }) => {
    const from = addMonths(today(), 24, 8);
    const to = addMonths(from, 0, 13);
    const items = await searchAll({ location: "hermanus", from, to });
    for (const item of items) c.ok(item.type !== "recurring", `the recurring "${item.title}" is returned ${from} to ${to}`);
    const generated = await query<{ title: string }>(
      state.dbUrl,
      `select distinct e.title from experience e join experience_session s on s.experience_id = e.id
        where s.origin = 'generated' and s.start_date <= '${to}' and s.end_date >= '${from}'`,
    );
    for (const item of items) {
      c.ok(!generated.some((one) => one.title === item.title), `"${item.title}" has only a generated session ${from} to ${to}`);
    }
    c.note(`Searched ${from} to ${to}: ${items.length} items.`);
  });

  scenario("E2E-44", "The most premium comes first", async ({ c }) => {
    const boat = (item: Experience) => /whale/i.test(item.title) && /(boat|cruise|charter)/i.test(item.title);
    const plain = (item: Experience) => /parkrun|market|markie/i.test(item.title);
    const stay: Body = { location: "hermanus", from: "2027-09-20", to: "2027-09-30" };
    const tiered = await query<{ n: number }>(state.dbUrl, "select count(*)::int as n from experience_attribute_value where attribute_key = 'tier'");
    if ((tiered[0]?.n ?? 0) === 0) c.fail("No captured experience carries a tier: the capture files have none yet");
    const session = await connect(mainServer(), client("agency agent"));
    try {
      for (const body of [stay, { ...stay, query: "whales" }]) {
        const items = await searchAll(body);
        for (let index = 1; index < items.length; index += 1) {
          const before = items[index - 1];
          const after = items[index];
          if (before && after && tierOf(after) < tierOf(before)) {
            c.fail(`${show(body)}: "${after.title}" (${TIERS[tierOf(after)] ?? ""}) comes after "${before.title}" (${TIERS[tierOf(before)] ?? ""})`);
            break;
          }
        }
        if (body.query === undefined) checkDateOrderWithinTier(c, items, "with no query text, the soonest first within a tier");
        const lastBoat = Math.max(-1, ...items.map((item, index) => (boat(item) ? index : -1)));
        const firstPlain = items.findIndex(plain);
        c.ok(items.some(boat), `${show(body)} has a whale-watching boat trip`);
        if (firstPlain !== -1 && lastBoat !== -1) {
          c.ok(lastBoat < firstPlain, `${show(body)}: "${items[lastBoat]?.title ?? ""}" comes after "${items[firstPlain]?.title ?? ""}"`);
        }
        const page = await search({ ...body, limit: 100 });
        const answer = await session.callTool("search_experiences", { ...body, limit: 100 });
        c.ok(isDeepStrictEqual(answer.structuredContent, page.result), `over MCP the items and order are the same for ${show(body)}`);
      }
      const premium = await searchAll({ ...stay, attributes: { tier: ["luxury", "premium"] } });
      c.ok(premium.length > 0, "something is luxury or premium from 20 to 30 September 2027");
      for (const item of premium) {
        c.ok(!plain(item), `"${item.title}" is returned for luxury and premium`);
        c.ok(item.attributes.tier?.some((tier) => tier === "luxury" || tier === "premium") === true, `"${item.title}" has tier ${show(item.attributes.tier)}`);
      }
      const answer = await session.callTool("search_experiences", { ...stay, attributes: { tier: ["luxury", "premium"] }, limit: 100 });
      const rest = await search({ ...stay, attributes: { tier: ["luxury", "premium"] }, limit: 100 });
      c.ok(isDeepStrictEqual(answer.structuredContent, rest.result), "over MCP the luxury and premium answer is the same");
    } finally {
      await session.close();
    }
  });
}
