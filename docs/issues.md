# Issues

The working list for version 1, as three tables: what is still being worked on, what is noted for phase 2, and what
is closed. One row per issue. A row says what the issue is and what was decided or built. Where a decision changes how
the system works, it is also in the document that owns the subject.

2026-11-23 · Meiring

**Status:** `In progress` being built now · `Open` needs something from outside the code · `Phase 2` noted, and not
part of version 1 · `Closed` decided, and built where it needed building.

## Being worked on

| # | Issue | Area | Status | What is happening |
| --- | --- | --- | --- | --- |
| 25 | A database outage during a key check answers 401, not 500 | Identity, API | In progress | Better Auth's key check catches every error and calls the key invalid. Being fixed, together with a review of every error the API returns: statuses, codes, headers and messages, over REST and MCP |
| 34 | An experience's own page address is not saved | Catalogue | In progress | Decided: an experience holds its own page address when its listing gives one. Being added from extraction through to search results |
| 35 | Venue coordinates are not extracted | Data processing | In progress | Decided: coordinates are extracted whenever the listing states them, in its structured data, a map link or its text. Being built. Venues whose listing states none are issue 45 |
| 36 | A Quicket event on several dates becomes one long session | Data processing | In progress | Quicket's structured data gives one start and one end, so search returns the event for the days in between. Being fixed in extraction, so no session covers a day the listing does not say it is on |
| 41 | A failed raw listing can be claimed again before its attempt is counted | Data processing | In progress | With more than one processing worker, another could claim it between the rollback and the mark. Being closed, with a test of two workers racing |
| 44 | Nothing runs lint, type checks and tests automatically | Tooling | In progress | A GitHub Actions workflow that runs lint, the type checks and the tests on every push and pull request is being added |
| 45 | A venue whose listing states no coordinates has no position | Data processing | Open | Such an experience is searched from its location's centre. Geocoding its address, through Google behind a port, needs a Google API key in the environment |

## Phase 2

| # | Issue | Area | What is noted |
| --- | --- | --- | --- |
| 22 | Catalogue never hears that a listing was verified | Discovery | Discovery knows when each listing was last seen. An unchanged listing is not processed, so Catalogue is not told. Stamping last verified on source links is for phase 2 |
| 31 | Pages that only fill in with JavaScript cannot be fetched by the web page adapter | Discovery | Such pages are read with the agent-browser CLI and loaded through the pipeline as captured pages (see [sources.md](sources.md)). A headless browser inside the adapter is for phase 2 |
| 37 | The next source does not take over when the leading listing goes | Data processing | A lower-priority listing only fills empty fields. When the leading link is removed, the experience keeps the values it has. The next source taking over is for phase 2 |
| 40 | A server stopped part way through a fetch uses up that fetch's retries | Jobs | The run stays marked as running until its timeout, and each retry in that time is refused and counted. With the defaults the fetch still happens. Fixing it belongs with the move to more durable jobs in version 2 |
| 42 | Jobs that are given up are only in pg-boss's own table | Jobs | A job whose retries are used up is logged as an error and stays in pg-boss's table. A dead letter queue belongs with the move to more durable jobs in version 2 |

## Closed

| # | Issue | Area | How it was closed |
| --- | --- | --- | --- |
| 1 | The Docker engine was down, and port 5432 belongs to another project | Environment | The project has its own Postgres on port 5434, on the `pgvector/pgvector:pg18` image, under the compose project name `magic-events`. The main checkout's `.env` still points at 5432 and needs the same change after the merge |
| 2 | Which table holds the tenant | Organizations | Our own `tenant` table. Better Auth's organization plugin is not used. There is no sign-up: the seed creates the tenants, their users on Better Auth's `user` table with `tenant_id` and `role`, and their API keys |
| 3 | Who an agent's credential belongs to | Identity | A user. Every credential is an API key that belongs to one user, and the key records whether a person or an agent uses it |
| 4 | MCP sign-in with OAuth | Identity | No OAuth in version 1. MCP authenticates with an API key, like REST |
| 5 | An experience with no position of its own | Catalogue | It is searched from its location's centre |
| 6 | Search cannot check attribute filters against the definitions | Catalogue | Catalogue calls Data processing's service for the attribute definitions. A key that is no attribute, an attribute that cannot be filtered on, a value that is none of its options or a value of the wrong type is refused, and the error lists what can be used |
| 7 | Semantic ranking is not built | Catalogue | Built: the embedding port, the Bedrock adapter, the embedding job, and search ordered by meaning and by keyword with reciprocal rank fusion |
| 8 | Search takes a point, not a location | Catalogue | Search takes a location's slug, such as `hermanus`, and searches around its centre with the default radius. A point still works |
| 9 | Sample experiences are inserted straight into Catalogue's tables | Seed | Left as it is. The samples are test data |
| 10 | PDF calendar and web page sources have no addresses | Discovery | Every source was looked up and fetched once. The addresses are in [hermanus-sources.md](hermanus-sources.md) |
| 11 | The health check needs an API key | API | `GET /health` needs no key. Every other endpoint does |
| 12 | The per-address rate limit is kept in memory | API | Left in memory: version 1 runs as one instance. The limit is 10000 requests a minute by default |
| 13 | One change row has one kind | Catalogue | As built: the first that applies of cancelled, removed, postponed, rescheduled, confirmed and changed |
| 14 | How long change history is kept | Catalogue | For good in version 1. Nothing prunes it |
| 15 | Who reads the data warehouse | Data processing | Nobody in version 1. It is loaded for the next version |
| 16 | Status and booking from a listing | Data processing | As built: the rule table in [data-processing.md](data-processing.md) |
| 17 | What sends a listing to be processed again | Data processing | Built: `pipeline reprocess` sends back one listing, the listings an experience was built from, a source's or a location's |
| 18 | Profile and versions | Data processing | As built: a change to the profile alone makes no new version |
| 19 | Does a location need a radius | Discovery | No. Extraction keeps experiences in the location and in neighbouring towns within about half an hour by road |
| 20 | Recurring experiences with no feed | Discovery | They come in from the organisers' own pages and from pages a browser scrape captures. A research source is for phase 2 |
| 21 | Quicket never makes a complete run | Discovery | Closed with 28. Quicket comes in as web pages, whose runs are complete |
| 23 | A web page's fingerprint changes on every fetch | Discovery | As built: the fingerprint is taken from the page's visible text and its structured data |
| 24 | A range filter leaves out experiences that have no value | Catalogue | A range with only a max also matches an experience with no value, so `minimum_age: { max: 12 }` finds it. A range with a min matches a recorded value only |
| 26 | A key's rate limit is fixed when the key is issued | Identity | Left as it is. The limit is a default, 10000 requests a minute, and is not a blocker |
| 27 | Seed values the documents do not give | Seed | As seeded. They are rows in `apps/api/src/seed/data/` and can be changed and seeded again |
| 28 | The Quicket and Ticketmaster API adapters are not built | Discovery | Not built in version 1: there is no API access. Quicket's events come in through its public pages |
| 29 | A newsletter archive fits no source kind | Discovery | Not a source in version 1 |
| 30 | The terms of AllEvents.in and Quicket were not checked | Discovery | Dropped |
| 32 | A failed fetch is not tried again until the source is next due | Discovery | The job queue tries a failed fetch again five times with a doubling wait, starting at 15 minutes |
| 33 | Sources are due on their own clocks, not at a fixed time of the week | Discovery | Each source is due one fetch interval after its last run started. A job looks for due sources every 15 minutes |
| 38 | Postponed to Confirmed without new dates is allowed | Catalogue | Not an issue. A postponed experience cannot be booked, and a source that confirms it again is taken at its word |
| 39 | Two fetches of one source at the same instant can both start a run | Discovery | Left as it is. The job queue keeps one fetch job per source waiting at a time |
| 43 | Moving experiences to Past and extending recurring sessions is not built | Catalogue | Built: the upkeep job sets finished experiences to Past, closes bookings whose close time has passed, and generates recurring sessions further ahead |
