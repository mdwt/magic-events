# @magic-events/api

The server. It serves the experience feed and tenant onboarding over REST and MCP, and runs the scheduler, which does
the background jobs: fetching sources, processing raw listings, embedding experiences and Catalogue's upkeep. It holds
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
| `POST` | `/v1/tenants` | Creates a tenant | System admin |
| `GET` | `/v1/tenants` | Lists every tenant | System admin |
| `GET` | `/v1/tenants/:slug` | One tenant, with its users | System admin |
| `PATCH` | `/v1/tenants/:slug` | Changes a tenant's name, status or configuration. Suspended turns its access off | System admin |
| `POST` | `/v1/tenants/:slug/users` | Adds a user to a tenant with the client role | System admin |
| `POST` | `/v1/users/:userId/credentials` | Issues an API key. The key is in this answer only | System admin |
| `GET` | `/v1/users/:userId/credentials` | Lists a user's keys, never the keys themselves | System admin |
| `DELETE` | `/v1/users/:userId/credentials/:credentialId` | Revokes a key | System admin |
| `POST` | `/mcp` | The MCP endpoint. `GET` and `DELETE` answer 405 | Client, system admin |

A client may act only while their tenant is active. The request and answer schemas are in `/openapi.json`.

## OpenAPI

The OpenAPI 3.1 document is built from the route schemas. The server serves it at `GET /openapi.json`, and
`apps/api/openapi.json` is the same document as a file. After a route or a schema changes, run `pnpm openapi` from the
repository root to write the file again, and commit it. `pnpm openapi:check` fails when the file is out of date, and CI
runs it. Neither needs a running database.

## MCP tools

| Tool | Does | Who |
| --- | --- | --- |
| `search_experiences` | The same as `POST /v1/experiences/search` | Client, system admin |
| `get_experience_changes` | The same as `POST /v1/experiences/changes` | Client, system admin |
| `create_tenant` | Creates a tenant | System admin |
| `list_tenants` | Lists every tenant | System admin |
| `get_tenant` | One tenant by its slug, with its users | System admin |
| `update_tenant` | Changes a tenant | System admin |
| `add_tenant_user` | Adds a user to a tenant with the client role | System admin |
| `issue_credential` | Issues an API key | System admin |
| `list_credentials` | Lists a user's keys | System admin |
| `revoke_credential` | Revokes a key | System admin |

The endpoint is Streamable HTTP and stateless: every POST is answered on its own, as JSON.

## Authentication

An API key is the only credential, for people and for agents, over REST and MCP alike. A key belongs to a user and
records whether a person or an agent uses it. Keys start with `mev_`, are stored only as a hash and are shown once, when
issued: by the seed (`pnpm db:seed` prints them), or by a system admin through the credentials endpoints or tools.

Send the key as `Authorization: Bearer <key>`, or as `x-api-key: <key>`. Every path checks it except `/health`, and a
path that does not exist answers 401 to a caller without a valid key.

A key that is missing, unknown, disabled or expired is 401 with one message, so a caller cannot tell which. A key that
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
    "message": "The request is not valid.",
    "details": [{ "path": "near.lat", "message": "Too big: expected number to be <=90" }],
    "requestId": "3f1c..."
  }
}
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | The body, query, address or tool arguments do not fit the schema, the body is not valid JSON, or a value is refused, such as an unknown location. The details say which fields and why |
| 401 | `unauthenticated` | The key is missing, unknown, disabled or expired. Comes with `WWW-Authenticate: Bearer realm="magic-events"` |
| 403 | `forbidden` | The caller may not do this, their tenant is suspended, or `/mcp` was called from a host or origin that is not allowed |
| 404 | `not_found` | Nothing is at this address, or no tenant, user or credential has this slug or ID |
| 405 | `method_not_allowed` | The address does not answer this method. `Allow` names the ones it does |
| 406 | `not_acceptable` | A POST to `/mcp` whose `Accept` does not name both `application/json` and `text/event-stream` |
| 409 | `conflict` | A tenant slug or an email address is taken. The details name the field |
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

The MCP endpoint is `POST /mcp` (Streamable HTTP, stateless). It authenticates like REST: `Authorization: Bearer <key>`.
The key comes from the seed, which prints it once, or from a system admin through the API.

Which key to use: an agent's key in a tenant, so the logs show that an agent is calling; or a system admin's key, to use
the onboarding tools.

### Claude Code

On the same machine as the server, Claude Code connects to localhost directly:

```sh
claude mcp add --transport http magic-events http://localhost:4000/mcp --header "Authorization: Bearer <key>"
```

### Claude on claude.ai, Claude Desktop and mobile

A custom connector connects from Anthropic's cloud, not from your machine. The server must be reachable over the public
internet at an HTTPS address on port 443, so `http://localhost` does not work. For a local server, open a tunnel:

1. With the server running, run `pnpm tunnel` from the repository root. It runs
   `cloudflared tunnel --url http://localhost:4000` and prints a public address, `https://<name>.trycloudflare.com`.
2. Add `<name>.trycloudflare.com` to `API_ALLOWED_HOSTS` in `.env`, and restart the server. The MCP endpoint answers
   only the host names listed there.
3. In Claude, go to Settings, Connectors, Add custom connector. The URL is `https://<name>.trycloudflare.com/mcp`.
4. For Authentication, choose **No sign-in**.
5. Under **Request headers** (in some organisations under Advanced), add a header named `authorization` whose value is
   `Bearer <key>`, typed in full: Claude sends the value exactly as entered.

Things to know:

- A quick tunnel gets a new address every time it starts. After restarting the tunnel, change `API_ALLOWED_HOSTS`,
  restart the server, and remove the connector and add it again with the new address.
- While the tunnel runs, the local API is reachable from the internet. Every endpoint but the health check needs an API
  key.
- Authentication settings cannot be changed once a connector is added. To change the key, remove the connector and add
  it again.
- Request headers on custom connectors are in beta and offered to a limited set of organisations. Where that section is
  not shown, a server that authenticates with an API key cannot be added as a custom connector. Version 1 has no OAuth
  (see [docs/v1-decisions.md](../../docs/v1-decisions.md)).
