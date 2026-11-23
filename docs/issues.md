# Issues and open questions

The working list for version 1. One row per issue in the table, and one section per issue below it with the detail.
An issue is closed by writing its decision here and, where it changes how the system works, in the document that owns
the subject.

2026-11-23 · Meiring

**Status:** `Open` needs a decision · `Provisional` built one way so work could go on, and needs confirming ·
`Blocked` waiting on something outside the code · `To do` decided, not built yet · `Closed` done.

| # | Issue | Area | Status |
| --- | --- | --- | --- |
| 1 | The Docker engine was down, and port 5432 belongs to another project | Environment | Closed |
| 2 | Which table holds the tenant | Organizations | Closed |
| 3 | Who an agent's credential belongs to | Identity | Closed |
| 4 | MCP sign-in with OAuth | Identity | Closed |
| 5 | An experience with no position of its own | Catalogue | Closed |
| 6 | Search cannot check attribute filters against the definitions | Catalogue | Open |
| 7 | Semantic ranking is not built | Catalogue | To do |
| 8 | Search takes a point, not a location | Catalogue | Open |
| 9 | Sample experiences are inserted straight into Catalogue's tables | Catalogue | To do |
| 10 | PDF calendar and web page sources have no addresses | Discovery | Closed |
| 11 | The health check needs an API key | API | Open |
| 12 | The per-address rate limit is kept in memory | API | Open |
| 13 | One change row has one kind | Catalogue | Provisional |
| 14 | How long change history is kept | Catalogue | Open |
| 15 | Who reads the data warehouse | Data processing | Open |
| 16 | Status and booking from a listing | Data processing | Provisional |
| 17 | What sends a listing to be processed again | Data processing | Open |
| 18 | Profile and versions | Data processing | Provisional |
| 19 | Does a location need a radius | Discovery | Provisional |
| 20 | Recurring experiences with no feed | Discovery | Open |
| 21 | Quicket never makes a complete run | Discovery | Open |
| 22 | Catalogue never hears that a listing was verified | Discovery | Open |
| 23 | A web page's fingerprint changes on every fetch | Discovery | Provisional |
| 24 | A range filter leaves out experiences that have no value | Catalogue | Open |
| 25 | A database outage during a key check answers 401, not 500 | Identity | Open |
| 26 | A key's rate limit is fixed when the key is issued | Identity | Open |
| 27 | Seed values the documents do not give | Seed | Provisional |
| 28 | The Quicket and Ticketmaster API adapters are not built | Discovery | Open |
| 29 | A newsletter archive fits no source kind | Discovery | Open |
| 30 | The terms of AllEvents.in and Quicket were not checked | Discovery | Open |
| 31 | Pages that only fill in with JavaScript cannot be fetched | Discovery | Open |
| 32 | A failed fetch is not tried again until the source is next due | Discovery | Closed |
| 33 | Sources are due on their own clocks, not at a fixed time of the week | Discovery | Closed |
| 34 | An experience's own page address is not saved | Catalogue | Open |
| 35 | Venue coordinates are not extracted | Data processing | Open |
| 36 | A Quicket event on several dates becomes one long session | Data processing | Open |
| 37 | The next source does not take over when the leading listing goes | Data processing | To do |
| 38 | Postponed to Confirmed without new dates is allowed | Catalogue | Open |
| 39 | Two fetches of one source at the same instant can both start a run | Discovery | Open |
| 40 | A server stopped part way through a fetch uses up that fetch's retries | Discovery | Open |
| 41 | A failed raw listing can be claimed again before its attempt is counted | Data processing | Open |
| 42 | Jobs that are given up are only in pg-boss's own table | Jobs | Open |
| 43 | Moving experiences to Past and extending recurring sessions is not built | Catalogue | To do |
| 44 | Nothing runs lint, type checks and tests automatically | Tooling | Open |

## 1. The Docker engine was down, and port 5432 belongs to another project

**Closed, 2026-11-23.** Docker Desktop's engine was not answering, and the Postgres on `localhost:5432` turned out to be
another project's container (`potion_pg`), which is why it rejected the `magic` user. Docker Desktop was restarted, and
this project now has a Postgres of its own:

- **Port 5434.** `docker-compose.yml` publishes `5434:5432`, and `DATABASE_URL` in `.env` and `.env.example` points
  there. Port 5432 is left to the other project.
- **Image `pgvector/pgvector:pg18`.** The experience embeddings need the pgvector extension, which the plain
  `postgres:18` image does not have.
- **Compose project name `magic-events`.** Fixed in `docker-compose.yml`, so the main checkout and every worktree share
  the one container and volume.
- The main checkout's own `.env` still points at 5432 and needs the same change after the merge.

## 2. Which table holds the tenant

**Closed, 2026-11-23.** Decided: the tenant is our own `tenant` table, owned by Organizations. Better Auth's
organization plugin is not used. Version 1 is not a full SaaS, so there is no sign-up: the seed creates both sides.

- **Our side:** the seed saves each tenant in the `tenant` table.
- **Better Auth's side:** the seed saves each user on Better Auth's `user` table, with the tenant and the role in two
  fields of ours (`tenant_id`, `role`), and issues each user's API keys through Better Auth. A user belongs to one
  tenant, and a system admin to none.
- Better Auth's HTTP handler is not mounted, so nothing signs up or signs in over HTTP.

## 3. Who an agent's credential belongs to

**Closed, 2026-11-23.** Decided: as built. Every credential is an API key that belongs to one user. Whether a person or
an agent uses the key is recorded on the key, so an agent's key acts as its user: the same tenant and the same role.

## 4. MCP sign-in with OAuth

**Closed, 2026-11-23.** Decided: no OAuth in version 1. MCP authenticates the same way as REST, with an API key in the
`Authorization: Bearer` header, for the first round and for testing.

## 5. An experience with no position of its own

**Closed, 2026-11-23.** Decided: as built. An experience with no position of its own is searched from its location's
centre, so it is still found. The venue's coordinates stay optional.

## 6. Search cannot check attribute filters against the definitions

**Open.** Attribute definitions belong to Data processing, and Catalogue calls no other domain. So search filters on the
attribute keys and values stored with each experience, and knows nothing about the definitions.

- **Effect:** a filter on a key that does not exist returns nothing, with no error. The "clients can filter on it" flag
  on a definition is stored and not enforced.
- **Ways out:** Catalogue is allowed to call Data processing for the definitions; or the definitions move to Catalogue;
  or it stays as it is.

## 7. Semantic ranking is not built

**To do.** A search's query text orders the results by keyword only (Postgres full-text search). The embedding column,
the model column and the pgvector extension are in place. The embedding port, the Bedrock adapter, the embedding worker
and the combined ranking in [data-processing.md](data-processing.md) are not built.

## 8. Search takes a point, not a location

**Open.** Search takes a latitude, a longitude and a radius, as decided in [architecture.md](architecture.md). An agent
asked about "Hermanus" has to know its coordinates.

- **Decide:** whether search also takes a location's slug and uses its centre.

## 9. Sample experiences are inserted straight into Catalogue's tables

**To do.** Experiences reach Catalogue only through its save-experience port, which Data processing will call, and that
port is not built yet. So the tests and the optional sample seed (`pnpm db:seed:samples`) insert experiences directly.
They write no change rows and no domain events. This goes when save-experience exists.

## 10. PDF calendar and web page sources have no addresses

**Closed, 2026-11-23.** Every source named in [discovery.md](discovery.md) was looked up and fetched once. The
addresses, what each returns and what is not usable are in [hermanus-sources.md](hermanus-sources.md). Thirteen sources
return dated, upcoming events to a plain request with no key. What the check changed:

- The Overstrand weekly diary is a web page on overstrand.gov.za, not a PDF.
- Quicket's public search pages return its Hermanus events with no key, as structured data in the page.
- Ticketmaster and Computicket hold no Hermanus events. SA-Venues has none for the Overstrand.

## 11. The health check needs an API key

**Open.** Every endpoint is authenticated, `GET /health` included. A load balancer or an uptime check would need a key of
its own.

## 12. The per-address rate limit is kept in memory

**Open.** The limit on requests per address is counted inside the one API process. With more than one instance, each
counts on its own. The per-key limit is in the database and is not affected.

## 24. A range filter leaves out experiences that have no value

**Open.** A range on a number attribute, such as `minimum_age: { max: 12 }`, matches only experiences that have a
minimum age recorded. Most experiences have none, because a source rarely states one, so an agent filtering for a
12-year-old loses nearly everything.

- **Decide:** whether an experience with no value passes a `max` range, a `min` range, both or neither.

## 25. A database outage during a key check answers 401, not 500

**Open.** Better Auth's key check catches every error inside it and reports the key as invalid. If the database is down,
a caller with a good key is told it is not authenticated. `GET /health` is the only endpoint that shows the outage.

## 26. A key's rate limit is fixed when the key is issued

**Open.** Better Auth copies the rate limit onto the key when it is created. Changing `API_KEY_RATE_LIMIT_MAX` or
`API_KEY_RATE_LIMIT_WINDOW_SECONDS` later changes new keys only.

## 27. Seed values the documents do not give

**Provisional.** These are rows, and they can be changed in `apps/api/src/seed/data/` and seeded again.

| Value | Seeded as |
| --- | --- |
| High season | 15 December to 15 January, each year |
| School holidays 2028 | The Department of Basic Education's proposed 2028 calendar. 2026 and 2027 are from the gazetted calendars |
| Source priority | 20 for Quicket and Ticketmaster, 10 for the Hermanus Times |
| Season slugs | `whale-season` and `south-african-school-holidays`, so they do not collide with the tags `whales` and `school-holidays` |

## 28. The Quicket and Ticketmaster API adapters are not built

**Open.** Neither has a key. Quicket's events come in through its public search pages, fetched as web pages.
Ticketmaster's public site returns no events for Hermanus or the Overstrand, so its adapter would return nothing today.

- **Decide:** whether the two API kinds are still wanted for version 1.

## 29. A newsletter archive fits no source kind

**Open.** The Hermanus Scoop is a weekly newsletter with a "What's On" section and no feed. Each issue has a new
address, so it is fetched like a PDF calendar: the archive page first, then the newest issue. No kind does that for a
web page.

## 30. The terms of AllEvents.in and Quicket were not checked

**Open.** Their `robots.txt` files allow the pages that are fetched. Whether their terms of use allow automated
fetching was not read.

## 31. Pages that only fill in with JavaScript cannot be fetched

**Open.** The web page adapter makes a plain request. Every source in use answers one. A page that only fills in with
JavaScript, such as Webtickets' search, would need a headless browser inside the adapter. None of the sources checked
needs it today.

## 32. A failed fetch is not tried again until the source is next due

**Closed, 2026-11-23.** Decided: a failed fetch is tried again five times with a doubling wait, starting at 15
minutes. When the retries are used up the source waits one fetch interval and starts again. The retries are the job
queue's work: a fetch is a job on a pg-boss queue, behind the job queue port. The rule is in
[discovery.md](discovery.md), under "When a fetch fails".

## 33. Sources are due on their own clocks, not at a fixed time of the week

**Closed, 2026-11-23.** Decided: a schedule per source is right. Each source is due one fetch interval after its last
run started. A job looks for due sources every 15 minutes, not every minute. Background work runs on a job queue behind
a port, with pg-boss as the first adapter (see Background jobs in [architecture.md](architecture.md)). A durable
workflow engine replaces it in the next version, by writing one adapter.

## 34. An experience's own page address is not saved

**Open.** Extraction returns the address of an experience's own page when the listing gives one. Catalogue's
experience has a booking link and an image, and no field for the page itself, so it is dropped.

- **Decide:** whether an experience holds its own page address.

## 35. Venue coordinates are not extracted

**Open.** The extractor returns a venue's name, address and city, and no coordinates: listings rarely give them and
the model cannot know them. Every experience from the pipeline is therefore searched from its location's centre
(issue 5), so the radius cannot tell a venue in Hermanus from one in Stanford.

- **Ways out:** a geocoding step behind a port; or coordinates from structured data where a page has them.

## 36. A Quicket event on several dates becomes one long session

**Open.** Quicket's structured data gives an event one start and one end. An event that is on several separate dates
between them comes out as one unbroken session, so search returns it for the days in between.

## 37. The next source does not take over when the leading listing goes

**To do.** [data-processing.md](data-processing.md) says that when the highest-priority link is removed, the next one
takes over. Built so far: a lower-priority listing only fills empty fields while a higher-priority one is linked.
When the leading link is removed, the experience keeps the values it has.

## 38. Postponed to Confirmed without new dates is allowed

**Open.** The status table says Postponed moves to Confirmed "with new dates". A save that confirms a postponed
experience and leaves its dates as they were is accepted, and is reported as Rescheduled.

## 39. Two fetches of one source at the same instant can both start a run

**Open.** A source with a run in progress is refused, but the check and the insert are two steps. The job queue keeps
one fetch job per source waiting at a time, which makes this unlikely. A hard guarantee needs a unique index on
running runs per source, which is a schema change.

## 40. A server stopped part way through a fetch uses up that fetch's retries

**Open.** The run stays marked as running until `DISCOVERY_RUN_TIMEOUT_MINUTES` has passed. Until then each retry of
the job is refused as "already being fetched" and counts as a retry. With the defaults the stale run is closed by the
third retry, so the fetch still happens. A processing job stopped by a shutdown also uses up a retry.

## 41. A failed raw listing can be claimed again before its attempt is counted

**Open.** When processing fails, the transaction rolls back, which makes the raw listing pending again, and the
attempt is recorded a moment later. With more than one processing worker, another could claim it in between.
`PROCESSING_WORKERS` is 1 by default.

## 42. Jobs that are given up are only in pg-boss's own table

**Open.** A job whose retries are used up is logged as an error and stays in pg-boss's job table for its default
retention. There is no dead letter queue and nothing shows them outside the logs.

## 43. Moving experiences to Past and extending recurring sessions is not built

**To do.** Catalogue's scheduled work in [data-model.md](data-model.md) is not built: setting finished experiences to
Past, closing bookings whose close time has passed, and generating the sessions of open-ended recurring experiences
further ahead as time passes. Search already leaves out sessions outside the dates asked for, so a finished
experience is not returned for future dates.

## 44. Nothing runs lint, type checks and tests automatically

**Open.** `pnpm lint`, `pnpm typecheck` and `pnpm test` cover every project, and the architecture rules are lint
rules. Nothing runs them on a push or before a commit: there is no CI workflow and no pre-commit hook. There is also
no formatter configuration.

## 13 to 23. Carried over from the documents

These are the open questions already written in the documents. They are listed here so everything open is in one place;
the detail stays where it is.

| # | Question | Detail in |
| --- | --- | --- |
| 13 | A change row has one kind, but one version can both confirm an experience and move its dates. Which does changed-since report? **Built:** the first that applies of cancelled, removed, postponed, rescheduled, confirmed, changed | [data-model.md](data-model.md) |
| 14 | How long is change history kept? | [architecture.md](architecture.md) |
| 15 | Who reads the data warehouse in version 1? | [architecture.md](architecture.md) |
| 16 | Which status and booking does a listing get when it says neither? **Built:** the proposed rule table | [data-processing.md](data-processing.md) |
| 17 | What sets a listing back to pending to be processed again? | [data-processing.md](data-processing.md) |
| 18 | Does a reworded profile count as a change and bump the version? **Built:** no, as proposed | [data-processing.md](data-processing.md) |
| 19 | Does a location need a radius for adapters to filter by? **Built:** extraction keeps experiences in the location and in neighbouring towns within about half an hour by road, as an instruction to the model | [discovery.md](discovery.md) |
| 20 | How do recurring experiences with no feed get in? A research source is proposed | [discovery.md](discovery.md) |
| 21 | Does the Quicket adapter also make a complete run at some interval? | [discovery.md](discovery.md) |
| 22 | Should Discovery tell Catalogue which listings it saw, so source links carry a last-verified time? | [discovery.md](discovery.md) |
| 23 | Is a web page's fingerprint taken from its visible text? **Built:** yes, from its visible text and its structured data | [discovery.md](discovery.md) |
