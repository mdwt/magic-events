# magic-events

A multi-tenant feed of experiences by location: festivals, concerts, matches, markets, shows. Travel agencies and travel
apps are the tenants. Their people and their AI agents query the same feed, through a REST API and an MCP interface, to
plan trips. Version 1 covers Hermanus, South Africa.

The brief and the principles the system is built on are in [AGENTS.md](AGENTS.md). Domain-driven design is kept light on
purpose: don't overcook it.

## Projects

| Project | What it is |
| --- | --- |
| [apps/api](apps/api/README.md) | The API: Fastify, REST and MCP, ports and adapters, five domains |
| [apps/web](apps/web/README.md) | The web app (Next.js) |
| [packages/db](packages/db/README.md) | The data model: Drizzle schema, migrations and the database client |

## Documents

| Document | Source of truth for |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The domains, their boundaries, the rules and the use cases |
| [docs/data-model.md](docs/data-model.md) | The resources the system stores and the rules they follow |
| [docs/discovery.md](docs/discovery.md) | How listings are fetched from sources |
| [docs/data-processing.md](docs/data-processing.md) | How a raw listing becomes experiences, and how search ranks them |
| [docs/domain-events.md](docs/domain-events.md) | The domain event log |
| [docs/issues.md](docs/issues.md) | The issues and open questions being worked on |
| [docs/v1-decisions.md](docs/v1-decisions.md) | What version 1 leaves out and why, for review |
| [docs/hermanus-sources.md](docs/hermanus-sources.md) | The Hermanus sources, as checked one by one |

## Getting started

Needs Node 24 or later, pnpm and Docker.

```sh
pnpm install
cp .env.example .env        # then set BETTER_AUTH_SECRET: openssl rand -base64 32
pnpm db:up                  # Postgres 18 with pgvector, on port 5434
pnpm db:migrate             # the development database
pnpm db:seed                # default data; prints the API keys once
pnpm dev                    # the API on port 4000 and the web app on port 3000
```

`pnpm db:seed:samples` adds a small set of sample experiences in Hermanus to search against.

## Scripts

| Script | Does |
| --- | --- |
| `pnpm dev` | Runs every project in watch mode |
| `pnpm build` | Builds every project |
| `pnpm typecheck` | Checks the types of every project |
| `pnpm lint` | Runs ESLint, which also checks the architecture rules of the API |
| `pnpm test` | Runs the tests. The API's tests use the database in `TEST_DATABASE_URL`, which they create and migrate themselves |
| `pnpm db:up`, `pnpm db:down` | Starts and stops Postgres in Docker |
| `pnpm db:migrate`, `pnpm db:migrate:test` | Applies the migrations to the development and the test database |
| `pnpm db:generate` | Generates a migration from a change to the schema |
| `pnpm db:seed`, `pnpm db:seed:samples` | Seeds the default data, and the sample experiences |
| `pnpm db:studio` | Opens Drizzle Studio |

## Workflow

Large changes are made in a separate git worktree with a clean install, committed as they go, and squash-merged into
`main` only when asked. See [AGENTS.md](AGENTS.md).
