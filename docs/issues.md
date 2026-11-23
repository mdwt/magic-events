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
| 2 | Which table holds the tenant | Organizations | Provisional |
| 3 | Who an agent's credential belongs to | Identity | Provisional |
| 4 | MCP sign-in with OAuth | Identity | Open |
| 5 | An experience with no position of its own | Catalogue | Provisional |
| 6 | Search cannot check attribute filters against the definitions | Catalogue | Open |
| 7 | Semantic ranking is not built | Catalogue | To do |
| 8 | Search takes a point, not a location | Catalogue | Open |
| 9 | Sample experiences are inserted straight into Catalogue's tables | Catalogue | To do |
| 10 | PDF calendar and web page sources have no addresses | Discovery | Open |
| 11 | The health check needs an API key | API | Open |
| 12 | The per-address rate limit is kept in memory | API | Open |
| 13 | One change row has one kind | Catalogue | Open |
| 14 | How long change history is kept | Catalogue | Open |
| 15 | Who reads the data warehouse | Data processing | Open |
| 16 | Status and booking from a listing | Data processing | Open |
| 17 | What sends a listing to be processed again | Data processing | Open |
| 18 | Profile and versions | Data processing | Open |
| 19 | Does a location need a radius | Discovery | Open |
| 20 | Recurring experiences with no feed | Discovery | Open |
| 21 | Quicket never makes a complete run | Discovery | Open |
| 22 | Catalogue never hears that a listing was verified | Discovery | Open |
| 23 | A web page's fingerprint changes on every fetch | Discovery | Open |
| 24 | A range filter leaves out experiences that have no value | Catalogue | Open |
| 25 | A database outage during a key check answers 401, not 500 | Identity | Open |
| 26 | A key's rate limit is fixed when the key is issued | Identity | Open |
| 27 | Seed values the documents do not give | Seed | Provisional |

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

**Provisional.** From the open question in [data-model.md](data-model.md): Better Auth's organization plugin has its own
organization and member tables, which overlap the tenant.

- **Built:** our own `tenant` table, owned by Organizations. A user's tenant and role are two fields on Better Auth's
  `user` table (`tenant_id`, `role`). The organization plugin is not used. A user belongs to one tenant, and a system
  admin to none.
- **The other way:** the organization plugin holds the tenant, with kind, status and configuration as extra fields on its
  organization table, and membership and role in its member table. That allows a user in several tenants, and adds the
  plugin's invitation table and its endpoints.
- **Decide:** keep our own table, or move to the plugin.

## 3. Who an agent's credential belongs to

**Provisional.** From the open question in [architecture.md](architecture.md).

- **Built:** every credential is an API key that belongs to one user. Whether a person or an agent uses the key is
  recorded on the key. An agent's key therefore acts as its user: the same tenant and the same role.
- **The other way:** a key that belongs to the tenant, with no user behind it.
- **Still missing either way:** no flow revokes a key. Keys are issued by the seed only.

## 4. MCP sign-in with OAuth

**Open.** Version 1 authenticates MCP the same way as REST: an API key in the `Authorization: Bearer` header. The MCP
specification's own sign-in is OAuth 2.1, which lets a client such as Claude connect by signing in, with no key to paste.
Better Auth has a plugin for it.

- **Decide:** whether version 1 needs it, or API keys are enough for the first round of testing.

## 5. An experience with no position of its own

**Provisional.** From the open question in [data-model.md](data-model.md): an experience always has a location, but the
venue's coordinates are optional, and radius search uses them.

- **Built:** search uses the location's centre when the experience has no position, so it is still found.
- **The other way:** every experience must have its own position, and one without is not saved.

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

**Open.** The seed creates the three sources that [discovery.md](discovery.md) gives enough to fetch: Quicket,
Ticketmaster and the Hermanus Times feed. The PDF calendars (whalecoast.info annual and monthly, the Overstrand weekly
diary) and the web page sources need their page addresses before they can be rows.

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

## 13 to 23. Carried over from the documents

These are the open questions already written in the documents. They are listed here so everything open is in one place;
the detail stays where it is.

| # | Question | Detail in |
| --- | --- | --- |
| 13 | A change row has one kind, but one version can both confirm an experience and move its dates. Which does changed-since report? | [data-model.md](data-model.md) |
| 14 | How long is change history kept? | [architecture.md](architecture.md) |
| 15 | Who reads the data warehouse in version 1? | [architecture.md](architecture.md) |
| 16 | Which status and booking does a listing get when it says neither? A rule table is proposed | [data-processing.md](data-processing.md) |
| 17 | What sets a listing back to pending to be processed again? | [data-processing.md](data-processing.md) |
| 18 | Does a reworded profile count as a change and bump the version? | [data-processing.md](data-processing.md) |
| 19 | Does a location need a radius for adapters to filter by? | [discovery.md](discovery.md) |
| 20 | How do recurring experiences with no feed get in? A research source is proposed | [discovery.md](discovery.md) |
| 21 | Does the Quicket adapter also make a complete run at some interval? | [discovery.md](discovery.md) |
| 22 | Should Discovery tell Catalogue which listings it saw, so source links carry a last-verified time? | [discovery.md](discovery.md) |
| 23 | Is a web page's fingerprint taken from its visible text? | [discovery.md](discovery.md) |
