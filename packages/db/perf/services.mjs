// Times the background work and the writes, through the core's own services, on a measurement database: saving an
// experience, match candidates, removing a source link, a discovery run, the upkeep, the embedding job, onboarding
// and the key check. The language model is never called, and the embedding model is a stand-in that returns random
// unit vectors, so only the system's own work is timed. It writes to the database it is given, as the jobs would.
//
//   DATABASE_URL=postgres://magic:magic@localhost:5434/magic_events_perf PERF_KEY=mev_... \
//     node --env-file-if-exists=.env packages/db/perf/services.mjs [only]
//
// With PERF_CONTAINER set (the Postgres container, logging every statement), each step also prints how many
// statements it ran and their time in the database.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDb } from "../src/index.ts";
import { createLogger } from "../../core/src/adapters/logging/pino.ts";
import { loadSettings } from "../../core/src/adapters/settings/env.ts";
import { createServices } from "../../core/src/services.ts";

const settings = loadSettings();
if (!/magic_events_perf/.test(settings.database.url)) throw new Error("services.mjs runs only on a magic_events_perf database.");
const only = process.argv[2];
const logger = createLogger({ ...settings.api, logLevel: "warn", logPretty: false });
const database = createDb(settings.database.url);

const randomVector = () => {
  const vector = Array.from({ length: 1024 }, () => Math.random() - 0.5);
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
};
const embeddingModel = {
  model: settings.embedding.model,
  dimensions: 1024,
  embed: (texts) => Promise.resolve(texts.map(randomVector)),
};
const languageModel = {
  ask: () => Promise.reject(new Error("The language model is not called while measuring.")),
};

// The listings the stand-in source publishes on each run.
let published = [];
const fetcher = {
  kind: "web_page",
  fetch: () => Promise.resolve({ listings: published, complete: true, syncState: {} }),
};
const listings = (count, version = 1) =>
  Array.from({ length: count }, (_, index) => ({
    sourceListingId: `perf-listing-${index}`,
    url: `https://perf.example.com/listing/${index}`,
    contentType: "text/html",
    content: `<html><body><h1>Perf listing ${index}</h1><p>Version ${version}. ${"Something on. ".repeat(200)}</p></body></html>`,
  }));

const services = createServices({
  settings,
  db: database.db,
  logger,
  overrides: { embeddingModel, languageModel, fetchers: [fetcher] },
});
const { catalogue, discovery, organizations, identity } = services;

const container = process.env.PERF_CONTAINER;
function statementsSince(since) {
  if (container === undefined) return "";
  const logs = spawnSync("docker", ["logs", "--since", since, container], { encoding: "utf8", maxBuffer: 1e9 });
  const lines = `${logs.stdout}${logs.stderr}`.split("\n").filter((line) => line.includes("duration:") && line.includes("execute"));
  const ms = lines.reduce((sum, line) => sum + Number(/duration: ([\d.]+) ms/.exec(line)?.[1] ?? 0), 0);
  return `\t${lines.length} statements\t${ms.toFixed(1)} ms in the database`;
}

async function step(name, work, runs = 1) {
  if (only !== undefined && !name.includes(only)) return undefined;
  const times = [];
  let result;
  const since = new Date().toISOString();
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    result = await work(i);
    times.push(performance.now() - started);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const shown = typeof result === "object" ? JSON.stringify(result)?.slice(0, 120) : String(result);
  console.log(
    `${name}\t${runs} run(s)\tmedian ${median.toFixed(1)} ms\tworst ${sorted.at(-1).toFixed(1)} ms${statementsSince(since)}\t${shown}`,
  );
  return result;
}

// ---- Catalogue writes ----

const home = await catalogue.getLocation({ slug: "hermanus" });
const [sample] = await database.db.execute(
  "select slug from experience where location_id = '" + home.id + "' and status = 'confirmed' and type = 'single' order by slug limit 1",
);
const stored = await catalogue.getExperience({ slug: sample.slug });
const inputOf = (experience, overrides = {}) => ({
  locationId: experience.locationId,
  title: experience.title,
  ...(experience.summary === null ? {} : { summary: experience.summary }),
  ...(experience.description === null ? {} : { description: experience.description }),
  ...(experience.profile === null ? {} : { profile: experience.profile }),
  type: experience.type,
  status: experience.status,
  booking: experience.booking,
  sessions: experience.sessions
    .filter((session) => session.origin === "listed")
    .map((session) => ({ startDate: session.startDate, endDate: session.endDate, precision: session.precision })),
  attributes: experience.attributes,
  tags: experience.tags,
  ...(experience.bookingUrl === null ? {} : { bookingUrl: experience.bookingUrl }),
  source: { listingId: randomUUID(), rawListingId: randomUUID() },
  precedence: "lead",
  ...overrides,
});

const created = await step("save: create", () =>
  catalogue.saveExperience(inputOf(stored, { title: `${stored.title} perf ${randomUUID().slice(0, 8)}` })),
);
if (created !== undefined) {
  const listingId = created.experience.listingIds[0];
  const update = inputOf(created.experience, { experienceId: created.experience.id, source: { listingId, rawListingId: randomUUID() } });
  await step("save: update", (i) => catalogue.saveExperience({ ...update, summary: `Changed ${i}` }), 5);
  await step(
    "save: unchanged",
    async () => {
      const now = await catalogue.getExperience({ id: created.experience.id });
      return catalogue.saveExperience(inputOf(now, { experienceId: now.id, source: { listingId, rawListingId: randomUUID() } }));
    },
    5,
  );
  await step("remove source link", () => catalogue.removeSourceLink({ listingId, rawListingId: randomUUID() }));
}

await step(
  "match candidates",
  () =>
    catalogue.findMatchCandidates({
      locationId: home.id,
      title: "Hermanus Country Market",
      from: "2026-12-01",
      to: "2027-03-01",
      monthOrYear: { from: "2026-01-01", to: "2027-12-31" },
    }),
  5,
);

// ---- Discovery ----

if (only === undefined || only.includes("discovery")) {
  const source = await discovery.saveSource({
    name: `Perf source ${randomUUID().slice(0, 8)}`,
    kind: "web_page",
    locationSlug: "hermanus",
    missedRunsBeforeRemoval: 1,
  });
  published = listings(300);
  await step("discovery: run, 300 new listings", () => discovery.runSource(source.id));
  await step("discovery: run, 300 unchanged", () => discovery.runSource(source.id));
  published = listings(300, 2);
  await step("discovery: run, 300 changed", () => discovery.runSource(source.id));
  published = listings(250, 2);
  await step("discovery: run, 50 missing", () => discovery.runSource(source.id));
  await step("discovery: claim with many pending", () =>
    database.db.transaction(async (tx) => {
      void tx;
      const claimed = await discovery.claimPendingRawListing();
      return claimed === null ? null : "claimed";
    }),
  );
}

// ---- Background jobs ----

await step("upkeep: keepUp", () => catalogue.keepUp());
await step("embedding: one round", () => catalogue.embedExperiences());
await step("embedding: until none left", async () => {
  let rounds = 0;
  for (;;) {
    const round = await catalogue.embedExperiences();
    rounds += 1;
    if (round.remaining <= 0 || round.embedded === 0) return { rounds, ...round };
  }
});

// ---- Organizations and Identity ----

await step("tenants: list", async () => (await organizations.listTenants()).length, 5);
const someTenant = (await organizations.listTenants()).find((one) => one.slug.startsWith("perf-tenant-"));
await step("tenants: list users", async () => (await organizations.listUsers(someTenant.id)).length, 5);
await step("onboard: tenant, user, key", async () => {
  const slug = `perf-onboard-${randomUUID().slice(0, 8)}`;
  await organizations.createTenant({ name: slug, slug, kind: "travel_agency" });
  const user = await organizations.createUser({ name: slug, email: `${slug}@example.com`, role: "client", tenantSlug: slug });
  return (await identity.issueCredential({ userId: user.id, kind: "person", name: "perf" })).id;
});
if (process.env.PERF_KEY !== undefined) {
  await step("identity: authenticate", () => identity.authenticate(process.env.PERF_KEY).then((caller) => caller.kind), 20);
}

await database.close();
