// Many clients at once: CONCURRENCY callers each send the same search, one after another, for SECONDS seconds.
// Prints the requests per second and the median, 95th percentile and worst time.
//
//   PERF_BASE=http://127.0.0.1:4100 PERF_KEY=mev_... node packages/db/perf/load.mjs [CONCURRENCY] [SECONDS]

const base = process.env.PERF_BASE ?? "http://127.0.0.1:4100";
const key = process.env.PERF_KEY;
if (!key) throw new Error("Set PERF_KEY to a seeded client's API key.");
const concurrency = Number(process.argv[2] ?? 20);
const seconds = Number(process.argv[3] ?? 10);
const body = JSON.stringify({ location: "hermanus", from: "2026-12-15", to: "2026-12-29" });

const times = [];
const statuses = new Map();
const end = Date.now() + seconds * 1000;
async function client() {
  while (Date.now() < end) {
    const started = performance.now();
    const response = await fetch(`${base}/v1/experiences/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    });
    await response.text();
    times.push(performance.now() - started);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  }
}
await Promise.all(Array.from({ length: concurrency }, client));
times.sort((a, b) => a - b);
const at = (fraction) => times[Math.min(times.length - 1, Math.floor(times.length * fraction))].toFixed(1);
console.log(
  `${concurrency} at once for ${seconds} s: ${times.length} requests, ${(times.length / seconds).toFixed(1)}/s, ` +
    `median ${at(0.5)} ms, p95 ${at(0.95)} ms, worst ${at(1)} ms, statuses ${JSON.stringify(Object.fromEntries(statuses))}`,
);
