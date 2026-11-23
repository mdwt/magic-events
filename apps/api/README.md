# @magic-events/api

The magic-events API: a read-only feed of experiences by location, for travel agencies, travel apps and their AI agents.
The one use case in version 1 is **search experiences**, offered the same way over REST (`POST /v1/experiences/search`)
and MCP (the `search_experiences` tool on `POST /mcp`). Every endpoint needs an API key.

Fastify 5 with Zod schemas, Better Auth with its API key plugin, the MCP TypeScript SDK, and Drizzle on Postgres
(through [packages/db](../../packages/db/README.md)).

## Layout

```
src/
  core/<domain>/   ports.ts (what the domain offers and needs) and service.ts (its business rules)
  core/shared/     errors, the Logger port, settings, the per-request log context
  rest/            the Fastify server, its hooks, the error format and the REST routes
  mcp/             the MCP endpoint, its server and its tools
  adapters/        outbound adapters: storage (one repository per domain), settings, auth, logging
  app.ts           the composition root: the only code that imports adapters and services
  server.ts        the entry point
  seed/            seed scripts and their data
test/              node:test tests, and test/helpers/harness.ts
```

Five domains: Catalogue, Discovery, Data processing, Identity and Organizations ([docs/architecture.md](../../docs/architecture.md)).
The rules, checked by ESLint (`eslint.config.mjs`):

- A domain's core imports no adapter, no provider's SDK and no database client.
- A domain calls another domain only through its ports, and only along the arrows in "How domains talk".
- REST and MCP call the core through its ports and hold no business logic. Both call the same service methods.
- Only `app.ts` imports adapters and services. Identity and Organizations use Better Auth directly, the one exception.

## Running it

From the repository root, with Postgres up and migrated (see the [root README](../../README.md)):

```sh
pnpm --filter @magic-events/api dev     # watch mode, on API_PORT
pnpm db:seed                            # tenants, users and their API keys, printed once
```

| Script | Does |
| --- | --- |
| `dev` | Runs the server and restarts it on change |
| `start` | Runs the server |
| `typecheck`, `build` | Checks the types |
| `lint` | ESLint, with the architecture rules |
| `test` | Runs every test, one file at a time |
| `seed`, `seed:samples` | Seeds the default data, and the sample experiences |

The server stops cleanly on SIGINT and SIGTERM: it finishes the requests in flight, then closes the database pool.

## Settings

Environment variables, read once at startup from the repository's `.env`. An invalid value stops the server with a
message that names the variable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | The Postgres database |
| `TEST_DATABASE_URL` | | The database the tests use. Read only by the tests, which empty every table in it |
| `API_HOST` | `0.0.0.0` | The address to listen on |
| `API_PORT` | `4000` | The port to listen on |
| `CORS_ORIGIN` | `http://localhost:3000` | The one browser origin allowed to call the API |
| `API_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | The host names the MCP endpoint answers to, against DNS rebinding |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `LOG_PRETTY` | `false` | Readable log lines for a terminal instead of JSON |
| `API_RATE_LIMIT_MAX` | `10000` | Requests one address may make in a window, before any key is checked |
| `API_RATE_LIMIT_WINDOW_SECONDS` | `60` | That window |
| `API_BODY_LIMIT_BYTES` | `65536` | The largest request body |
| `BETTER_AUTH_SECRET` | required | At least 32 characters: `openssl rand -base64 48` |
| `API_KEY_RATE_LIMIT_MAX` | `10000` | Requests one API key may make in a window. A key gets this when it is issued |
| `API_KEY_RATE_LIMIT_WINDOW_SECONDS` | `60` | That window |
| `SEARCH_DEFAULT_RADIUS_KM` | `25` | The radius of a search that gives none |
| `SEARCH_MAX_RADIUS_KM` | `200` | The largest radius a search may ask for |
| `DISCOVERY_DEFAULT_FETCH_INTERVAL_HOURS` | `168` | A new source's fetch interval, when it gives none: once a week |
| `DISCOVERY_DEFAULT_MISSED_RUNS_BEFORE_REMOVAL` | `3` | Complete runs without a listing before its source link is removed |
| `DISCOVERY_DEFAULT_MAX_PROCESSING_ATTEMPTS` | `3` | Tries at processing a raw listing before it fails |

## Authentication

API keys are the only credential, for people and for agents, over REST and MCP alike. A key belongs to a user, and
records whether a person or an agent uses it. Keys start with `mev_`, are stored only as a hash, and are shown once,
when they are issued. Version 1 has no sign-up, sign-in or key-management endpoint: keys are issued by the seed
(`pnpm db:seed` prints them), through Identity's `issueCredential`.

Every endpoint checks the key except `/health`, which needs none so that a load balancer or an uptime check can call
it. `/openapi.json` and `/mcp` check it too, and a path that does not exist answers 401 to a caller without a valid
key. A client may act while their tenant is active, and a system admin may do everything. Each key is rate limited on
its own, and each address before any key is checked. Both limits are set high by default: version 1 runs as one
instance, and they are there to stop a runaway client, not to meter use.

Over REST, send the key in the Authorization header (or as `x-api-key: <key>`):

```sh
curl http://localhost:4000/health
curl -H "Authorization: Bearer mev_..." -H "Content-Type: application/json" \
  -d '{"location":"hermanus","from":"2027-06-10","to":"2027-06-20"}' \
  http://localhost:4000/v1/experiences/search
```

Over MCP, connect a client that speaks Streamable HTTP to `http://localhost:4000/mcp` and give it the same header.
For example, in an MCP client's configuration:

```json
{
  "mcpServers": {
    "magic-events": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer mev_..." }
    }
  }
}
```

The endpoint is stateless: every POST is answered on its own, as JSON. `GET` and `DELETE` answer 405.

The OpenAPI document is at `GET /openapi.json`, with the same key.

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
| 400 | `invalid_input` | The body or query does not fit the schema, is not JSON, has the wrong content type or is too large |
| 401 | `unauthenticated` | The key is missing, unknown, disabled or expired. Comes with `WWW-Authenticate: Bearer` |
| 403 | `forbidden` | The caller may not do this, or their tenant is suspended |
| 404 | `not_found` | Nothing is there |
| 429 | `rate_limited` | Too many requests. `Retry-After` says how many seconds to wait |
| 500 | `internal_error` | Something went wrong on the server. The details are in the logs under the request ID |

Every answer carries an `x-request-id` header. An incoming `x-request-id` is kept when it is a plain token. Every log
line of a request carries the request ID and, once the key is checked, the tenant, user, caller kind, role and key ID.

Over MCP, a tool that fails answers `isError: true` with the same code, message and details as text.

## Tests

The tests use the built-in `node:test`. The database tests run against `TEST_DATABASE_URL`, which they create, migrate
and empty themselves, so never point it at a database you want to keep.

```sh
pnpm --filter @magic-events/api test
# one file
cd apps/api && node --env-file-if-exists=../../.env --test test/platform.test.ts
```

Logs are silent in the tests unless `LOG_LEVEL` is set.
