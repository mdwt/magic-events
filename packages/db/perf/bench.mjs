// Times the client's requests against a running API (see serve.mjs): each scenario once to warm up, then RUNS times
// one after another. Prints the median and the worst, in milliseconds, with the status and the total returned.
//
//   PERF_BASE=http://127.0.0.1:4100 PERF_KEY=mev_... node packages/db/perf/bench.mjs [RUNS] [name filter]

const base = process.env.PERF_BASE ?? "http://127.0.0.1:4100";
const key = process.env.PERF_KEY;
if (!key) throw new Error("Set PERF_KEY to a seeded client's API key.");
const runs = Number(process.argv[2] ?? 7);
const only = process.argv[3];

const day = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * day).toISOString();

const weekend = { from: "2026-12-12", to: "2026-12-13" };
const fortnight = { from: "2026-12-15", to: "2026-12-29" };
const june = { from: "2027-06-10", to: "2027-06-20" };
const year = { from: "2027-01-01", to: "2027-12-31" };
const hermanus = { location: "hermanus" };
// A point in a cluster of three perf towns, far from Hermanus.
const cluster = { near: { lat: -36, lng: -110 }, radiusKm: 60 };

const search = (body) => ({ path: "/v1/experiences/search", body });
const changes = (body) => ({ path: "/v1/experiences/changes", body });
const mcp = (name, args) => ({
  path: "/mcp",
  body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  mcp: true,
});

const scenarios = {
  "health (no key check)": { path: "/health", method: "GET" },
  "search hermanus weekend": search({ ...hermanus, ...weekend }),
  "search hermanus fortnight": search({ ...hermanus, ...fortnight }),
  "search hermanus june trip": search({ ...hermanus, ...june }),
  "search hermanus year": search({ ...hermanus, ...year }),
  "search hermanus year offset 2000": search({ ...hermanus, ...year, offset: 2000 }),
  "search hermanus year limit 100": search({ ...hermanus, ...year, limit: 100 }),
  "search point cluster fortnight": search({ ...cluster, ...fortnight }),
  "search point radius 200 year": search({ near: { lat: -34.4187, lng: 19.2345 }, radiusKm: 200, ...year }),
  "search category list": search({ ...hermanus, ...fortnight, attributes: { category: ["music", "visual_arts"] } }),
  "search option + setting": search({ ...hermanus, ...year, attributes: { audience: "adults", setting: "outdoor" } }),
  "search range max only": search({ ...hermanus, ...year, attributes: { minimum_age: { max: 12 } } }),
  "search range min": search({ ...hermanus, ...year, attributes: { minimum_age: { min: 18 } } }),
  "search boolean": search({ ...hermanus, ...year, attributes: { wheelchair_accessible: true } }),
  "search tags": search({ ...hermanus, ...fortnight, tags: ["wine", "whale-season"] }),
  "search bookable": search({ ...hermanus, ...year, bookable: true }),
  "search status confirmed": search({ ...hermanus, ...june, status: ["announced", "expected"] }),
  "search query text": search({ ...hermanus, ...june, query: "quiet romantic art and wine" }),
  "search query text year": search({ ...hermanus, ...year, query: "live music by the sea" }),
  "changes 7d": changes({ ...hermanus, ...fortnight, since: ago(7) }),
  "changes 365d": changes({ ...hermanus, ...fortnight, since: ago(365) }),
  "changes 365d year": changes({ ...hermanus, ...year, since: ago(365) }),
  "changes 365d year offset 1000": changes({ ...hermanus, ...year, since: ago(365), offset: 1000 }),
  "changes 365d filters": changes({
    ...hermanus,
    ...year,
    since: ago(365),
    attributes: { category: ["music"] },
    tags: ["summer"],
    bookable: true,
  }),
  "changes point 30d": changes({ ...cluster, ...year, since: ago(30) }),
  "mcp search hermanus fortnight": mcp("search_experiences", { ...hermanus, ...fortnight }),
};

async function call(scenario) {
  const headers = { authorization: `Bearer ${key}` };
  if (scenario.body !== undefined) headers["content-type"] = "application/json";
  if (scenario.mcp) headers.accept = "application/json, text/event-stream";
  const started = performance.now();
  const response = await fetch(base + scenario.path, {
    method: scenario.method ?? "POST",
    headers,
    body: scenario.body === undefined ? undefined : JSON.stringify(scenario.body),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  let total;
  try {
    const parsed = JSON.parse(text);
    if (scenario.mcp) {
      const inner = JSON.parse(parsed.result?.content?.[0]?.text ?? "{}");
      total = inner.total ?? (parsed.result?.isError ? "error" : "");
    } else {
      total = parsed.total ?? parsed.error?.code ?? "";
    }
  } catch {
    total = "";
  }
  return { ms, status: response.status, total };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// With --trace, each scenario is called once and the statements Postgres logged for it are printed: the database
// needs log_min_duration_statement = 0 (see README.md), and PERF_CONTAINER names the Postgres container.
if (process.argv.includes("--trace")) {
  const { spawnSync } = await import("node:child_process");
  const container = process.env.PERF_CONTAINER ?? "magic-events-postgres-1";
  const filter = process.argv[process.argv.indexOf("--trace") + 1];
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (filter !== undefined && !name.includes(filter)) continue;
    await call(scenario);
    const since = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await call(scenario);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Postgres logs to its standard error, which docker logs gives back on its own.
    const logs = spawnSync("docker", ["logs", "--since", since, container], { encoding: "utf8" });
    const lines = `${logs.stdout}${logs.stderr}`
      .split("\n").filter((line) => line.includes("duration:") && line.includes("execute"));
    let sum = 0;
    console.log(`\n== ${name}: ${result.status}, ${result.ms.toFixed(1)} ms, ${lines.length} statements`);
    for (const line of lines) {
      const ms = Number(/duration: ([\d.]+) ms/.exec(line)?.[1] ?? 0);
      sum += ms;
      const statement = line.replace(/^.*?execute [^:]*: /, "").replace(/\s+/g, " ");
      console.log(`${ms.toFixed(2).padStart(9)} ms  ${statement.slice(0, Number(process.env.PERF_WIDTH ?? 160))}`);
    }
    console.log(`${sum.toFixed(2).padStart(9)} ms  in the database`);
  }
  process.exit(0);
}

console.log(["scenario", "status", "total", "median ms", "worst ms"].join("\t"));
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only !== undefined && !name.includes(only)) continue;
  await call(scenario);
  const times = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    last = await call(scenario);
    times.push(last.ms);
  }
  console.log([name, last.status, last.total, median(times).toFixed(1), Math.max(...times).toFixed(1)].join("\t"));
}
