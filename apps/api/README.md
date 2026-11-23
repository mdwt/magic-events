# @magic-events/api

The server. It serves the experience feed to clients over REST and MCP, and runs the scheduler, which does the
background jobs: fetching sources, processing raw listings, embedding experiences and Catalogue's upkeep. It holds
no business rules: every route, tool and job handler calls a service of [packages/core](../../packages/core/README.md).

Fastify 5 with Zod schemas and the MCP TypeScript SDK.

## Layout

| Path | Holds |
| --- | --- |
| `src/rest/` | The Fastify server, authentication, the error format, request logging, and the routes in `routes/` |
| `src/mcp/` | The MCP endpoint, its server, and the tools in `tools/` |
| `src/scheduler/` | The job handlers (`handlers.ts`) and their schedules (`jobs.ts`) |
| `src/app.ts` | Builds the server on the core's services |
| `src/server.ts` | The entry point: settings, logger, database, the server, then the jobs |
| `src/openapi.ts` | Writes the OpenAPI document to `openapi.json` |
| `test/` | `node:test` tests, with `test/helpers/harness.ts` |

ESLint (`eslint.config.mjs`) keeps REST, MCP and the scheduler to the core's ports: they import no adapter, no service,
no database client, no queue library and no model SDK. Only `app.ts` and `server.ts` import the wiring.

## Running it

From the repository root, with Postgres up, migrated and seeded (see the [root README](../../README.md)):

```sh
pnpm --filter @magic-events/api dev
```

| Script | Does |
| --- | --- |
| `dev` | Runs the server and restarts it on change |
| `start` | Runs the server |
| `build`, `typecheck` | Checks the types |
| `lint` | Runs ESLint, with the rules above |
| `test` | Runs every test, one file at a time |
| `openapi`, `openapi:check` | Writes `openapi.json`, and fails when it is out of date. See [OpenAPI](#openapi) |

The server stops cleanly on SIGINT and SIGTERM: the jobs in hand finish, then the requests in flight, then the database
pool closes.

## Endpoints

| Method | Path | Does | Who |
| --- | --- | --- | --- |
| `GET` | `/health` | Whether the server is up and reaches its database. 503 while it cannot | Anyone, no key |
| `GET` | `/openapi.json` | The OpenAPI 3.1 document | Client, system admin |
| `POST` | `/v1/experiences/search` | Experiences near a location or a point that are on between two dates | Client, system admin |
| `POST` | `/v1/experiences/changes` | What changed since a time, among the experiences the same search selects | Client, system admin |
| `POST` | `/mcp` | The MCP endpoint. `GET` and `DELETE` answer 405 | Client, system admin |

A client may act only while their tenant is active. The request and answer schemas are in `/openapi.json`.

The API is for clients and has no admin endpoints. Tenants, users and keys are managed from the command line, with
`pnpm cli:admin`: see [apps/cli](../cli/README.md).

## OpenAPI

The OpenAPI 3.1 document is built from the route schemas. The server serves it at `GET /openapi.json`, and
`apps/api/openapi.json` is the same document as a file. After a route or a schema changes, run `pnpm openapi` from the
repository root to write the file again, and commit it. `pnpm openapi:check` fails when the file is out of date, and CI
runs it. Neither needs a running database.

## MCP

The MCP server is for clients: a travel agent, or the AI agent working for one, who wants to know what is on in a
place while a traveller is there. It offers the same two things as REST, and nothing else:

| Tool | Does | Same as |
| --- | --- | --- |
| `search_experiences` | What is on near a place between two dates, filtered by what must hold and ordered by what the traveller likes | `POST /v1/experiences/search` |
| `get_experience_changes` | What changed since an earlier search of the same place and dates: new, confirmed, rescheduled, postponed, cancelled, removed or otherwise changed | `POST /v1/experiences/changes` |

Both are read-only, and every caller sees exactly these two.

It authenticates like REST: every request carries an API key, as `Authorization: Bearer <key>` or `x-api-key: <key>`.
Use an agent's key, so the logs show that an agent is calling. A request without a valid key is 401 with
`WWW-Authenticate`, and a key whose tenant is suspended is 403. Every tool call is logged at info with the tool, its
arguments and the caller; the key never is.

### What an agent sees

An agent knows only what the server tells it, so the server explains itself:

- **The instructions**, sent once at `initialize` (`src/mcp/server.ts`): what the feed is and who it is for, which tool
  to use when, that what must hold goes in the filters while `query` only orders, how to read sessions, statuses,
  `bookable` and price, how paging works, and what to do with a refusal.
- **Each tool's title and description** (`src/mcp/tools/catalogue.ts`): when to use it and when not, the smallest call
  that works, worked examples, the attribute keys with their options, the tag and season slugs, what comes back and
  how to put it to a person, and the limits.
- **The input and output schemas**, shared with REST and the OpenAPI document (`packages/core/src/catalogue/ports.ts`),
  with a description on every field.

Instructions and descriptions come to about 9,100 characters; with the input schemas, about 17,700.

A refused call is a tool error (`isError: true`) whose text is the REST error body, with `code`, `message`, `details`
naming each field, and `requestId`, so an agent can correct its call. A tool that does not exist is the protocol's
unknown-tool error, JSON-RPC `-32602`.

### What a planner might ask

| A planner asks Claude | Claude calls |
| --- | --- |
| "A retired couple who love art and nature are in Hermanus from 20 to 30 June 2027. What is on for them?" | `search_experiences` with `{ "location": "hermanus", "from": "2027-06-20", "to": "2027-06-30", "query": "art, galleries, nature and wildlife" }` |
| "What can my family, with a ten-year-old, book for 7 to 20 December?" | `search_experiences` with `{ "location": "hermanus", "from": "2026-12-07", "to": "2026-12-20", "bookable": true, "attributes": { "minimum_age": { "max": 10 } } }` |
| "Anything changed for the June trip since I looked on 1 February?" | `get_experience_changes` with `{ "location": "hermanus", "from": "2027-06-20", "to": "2027-06-30", "since": "2027-02-01T09:00:00Z" }` |

### Limits

- The feed covers Hermanus and the towns near it, up to 24 months ahead. A place far from there returns nothing.
- Search never returns cancelled or removed experiences; changes reports them.
- Up to 100 results a page, 20 by default; `total` says how many there are across all pages.

### The protocol

- Streamable HTTP at `POST /mcp`, stateless: every POST is answered on its own, as JSON, with no session ID.
  `GET` and `DELETE` answer 405, as there is no event stream to open or session to end.
- `initialize` agrees the protocol version the client asks for when the SDK supports it (2025-11-25, 2025-06-18,
  2025-03-26 or 2024-11-05), and the latest otherwise. A later request may leave `MCP-Protocol-Version` out; one that
  names a version the server does not speak is 400.
- A notification is answered 202 with no body. A batch, which the 2025-03-26 revision allows, is answered with a batch.
- The server declares the tools capability alone, with a list that never changes.
- `Accept` must name both `application/json` and `text/event-stream` (406 otherwise). The `Host` must be one of
  `API_ALLOWED_HOSTS` and a browser's `Origin` must be `CORS_ORIGIN` (403 otherwise), against DNS rebinding.

## Authentication

An API key is the only credential, for people and for agents, over REST and MCP alike. A key belongs to a user and
records whether a person or an agent uses it. Keys start with `mev_`, are stored only as a hash and are shown once, when
issued: by the seed (`pnpm db:seed` prints them), or by a system admin with `pnpm cli:admin key issue`.

Send the key as `Authorization: Bearer <key>`, or as `x-api-key: <key>`. Every path checks it except `/health`, and a
path that does not exist answers 401 to a caller without a valid key.

A key that is missing, unknown, revoked or expired gets a 401, and the message is the same for all four, so a caller
cannot tell which. A key that
cannot be checked, because the database cannot be reached, is never 401: the answer is 503 `unavailable` with
`Retry-After`, as `/health` gives while the database is down. Better Auth's key check reports any failure inside it as
an invalid key, so Identity trusts that verdict only once the key store answers.

```sh
curl http://localhost:4000/health
curl -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"location":"hermanus","from":"2027-06-10","to":"2027-06-20"}' \
  http://localhost:4000/v1/experiences/search
```

Each key is rate limited on its own, and each address before any key is checked. Both limits are set high by default,
to stop a runaway client, not to meter use.

## Errors

Every REST failure has one format:

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Give near.lat, the latitude, as a number from -90 to 90, such as -34.4187.",
    "details": [
      { "path": "near.lat", "message": "Give near.lat, the latitude, as a number from -90 to 90, such as -34.4187." }
    ],
    "requestId": "3f1c..."
  }
}
```

The message is written for the person on the other end, and an agent can pass it on as it is. It says what went wrong
and what to do instead. When the details name several problems, the message gives each one in turn. Each detail's
message makes sense on its own, so the details also let a client mark the fields to fix.

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | The body, query, address or tool arguments do not fit the schema, the body is not valid JSON, or a value is refused, such as a place the feed does not cover. The details say which fields and what to give |
| 401 | `unauthenticated` | The key is missing, unknown, revoked or expired. Comes with `WWW-Authenticate: Bearer realm="magic-events"` |
| 403 | `forbidden` | The caller's organisation is suspended, or `/mcp` was called from a host or origin that is not allowed |
| 404 | `not_found` | Nothing is at this address |
| 405 | `method_not_allowed` | The address does not answer this method. `Allow` names the ones it does |
| 406 | `not_acceptable` | A POST to `/mcp` whose `Accept` does not name both `application/json` and `text/event-stream` |
| 413 | `content_too_large` | The body is larger than `API_BODY_LIMIT_BYTES` |
| 415 | `unsupported_media_type` | The body is not sent as `application/json` |
| 429 | `rate_limited` | Too many requests from this key or this address. `Retry-After` and the message say how many seconds to wait |
| 500 | `internal_error` | Something went wrong on the server. The message is general; the error is logged in full under the request ID |
| 503 | `unavailable` | The database cannot be reached, from any endpoint and from the health check. `Retry-After` says when to try again |

Every error body carries `requestId`, every answer the `x-request-id` header and `Cache-Control: no-store`, and every
log line of the request the same ID. A refused call is logged at warn with its reason, a system error at error in full,
with its cause.

Over MCP, a JSON-RPC answer comes with 200. A tool that fails answers `isError: true` with, as text, the body REST would
answer, request ID included. Arguments that do not fit a tool are `invalid_input` with one detail per field, so an agent
can correct its call, and the caller's right to the tool is checked before them. A tool that does not exist is a
JSON-RPC invalid params error. A refusal at the HTTP level, such as 401, 403, 405 or 406, is in the format above.

## Logs

Pino writes one JSON line per event to standard output (`LOG_PRETTY=true` for readable lines). `LOG_LEVEL` sets how
much: `info` by default.

| Level | What is logged |
| --- | --- |
| `debug` | Every request as it starts; the resolved search or changes query, with its count and duration; a job starting and finishing; a run starting; each page fetched |
| `info` | Every request completed, with `method`, `url`, `statusCode` and `durationMs`; the server started, with its settings that are safe to show, and stopped; each MCP tool called, with its arguments; a run finished, with its counts; a raw listing processed, with its outcome; an experience published or changed; each domain event published (`eventId`, `type`, `resourceId`); a tenant created, a user added, a key issued or revoked |
| `warn` | A refused call, with `reason` and, for wrong input, `details` naming each field; a job that failed and will be tried again |
| `error` | A system error, with `err` in full; a job given up; the database out of reach |

Every line of a request carries `requestId`, the `x-request-id` the client got back. Once the key is checked, every line
also carries who is calling: `tenantId`, `userId`, `callerKind` (person or agent), `role` and `credentialId`. A job's
lines carry `job` and `jobId`. No key and no `Authorization` header is ever logged.

```sh
# One request, from the inbound side through the domain service, in order
jq -c 'select(.requestId == "3f1c...")' server.log
# One client's calls: by key, or by user
jq -c 'select(.credentialId == "<key ID>" and .msg == "Request completed") | {time, method, url, statusCode, durationMs}' server.log
# Every refusal and failure
jq -c 'select(.level >= 40) | {time, requestId, userId, msg, reason, code}' server.log
```

## Background jobs

`src/server.ts` starts the jobs once the server is listening, on pg-boss queues in the same database. Every 15 minutes
(`DISCOVERY_SCHEDULE_CRON`) the scheduler finds the sources that are due and fetches each one; a fetch that found
something queues processing, and processing that saved anything queues embedding. Processing also runs every hour and
embedding every 15 minutes as a safety net, and Catalogue's upkeep runs every hour (`CATALOGUE_UPKEEP_CRON`). So a
running server fetches real websites and calls the language model by itself. What each job does is in
[docs/architecture.md: Background jobs](../../docs/architecture.md#background-jobs).

## Settings

Environment variables, read once at startup from the repository's `.env`. An invalid value stops the server with a
message that names the variable. The full list, with defaults, is in [.env.example](../../.env.example).

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | The Postgres database. Required |
| `BETTER_AUTH_SECRET` | At least 32 characters: `openssl rand -base64 48`. Required |
| `API_HOST`, `API_PORT` | Where the server listens. `0.0.0.0` and `4000` by default |
| `API_ALLOWED_HOSTS` | The host names the MCP endpoint answers to, comma-separated, against DNS rebinding |
| `CORS_ORIGIN` | The one browser origin allowed to call the API |
| `LOG_LEVEL`, `LOG_PRETTY` | How much is logged, and readable lines instead of JSON |
| `ANTHROPIC_API_KEY` | The language model, which the jobs use to process listings |
| `AWS_REGION` and AWS credentials | The embedding model on Amazon Bedrock. Without it, search orders by keyword alone |
| `TEST_DATABASE_URL` | The database the tests use. They empty every table in it |

## Tests

```sh
pnpm --filter @magic-events/api test
```

The tests run against `TEST_DATABASE_URL`, which they create and migrate themselves. Logs are silent unless `LOG_LEVEL`
is set.

## Connecting Claude

The MCP endpoint is `POST /mcp` (Streamable HTTP, stateless), and it takes the same API key as REST:
`Authorization: Bearer <key>`. The steps for Claude Desktop, claude.ai and Claude Code, with a Cloudflare tunnel for a
local server, are in the [root README](../../README.md#connect-claude).
