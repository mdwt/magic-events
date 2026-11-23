# magic-events

A multi-tenant feed of what is on in a place: festivals, concerts, matches, markets, shows, exhibitions and seasons.
Travel agencies and travel apps are the tenants. Their people and their AI agents query the same feed, through a REST
API and an MCP endpoint, to plan trips. Version 1 covers Hermanus, South Africa.

The brief and the principles the system is built on are in [AGENTS.md](AGENTS.md). Domain-driven design is kept light on
purpose: don't overcook it.

## Projects

| Project | What it is |
| --- | --- |
| [apps/api](apps/api/README.md) | The server: REST, MCP and the scheduler that runs the background jobs |
| [apps/cli](apps/cli/README.md) | Command-line tools: the seed, the pipeline run by hand, and the loader for captured pages |
| [apps/web](apps/web/README.md) | The web app (Next.js) |
| [packages/core](packages/core/README.md) | The five domains, their ports, the outbound adapters and the wiring |
| [packages/db](packages/db/README.md) | The Drizzle schema, the migrations and the database client |

## Documents

| Document | Source of truth for |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The domains, their boundaries, the rules, the background jobs and the use cases |
| [docs/data-model.md](docs/data-model.md) | The resources the system stores and the rules they follow |
| [docs/discovery.md](docs/discovery.md) | How listings are fetched from sources |
| [docs/data-processing.md](docs/data-processing.md) | How a raw listing becomes experiences, and how search ranks them |
| [docs/domain-events.md](docs/domain-events.md) | The domain event log |
| [docs/sources.md](docs/sources.md) | The sources the system holds for Hermanus |
| [docs/hermanus-sources.md](docs/hermanus-sources.md) | Which Hermanus sites answer a plain fetch, checked one by one |
| [docs/v1-decisions.md](docs/v1-decisions.md) | What version 1 leaves out and why, for review |
| [docs/issues.md](docs/issues.md) | The issues and open questions being worked on |

## Getting started

Needs Node 24 or later, pnpm and Docker.

```sh
pnpm install
cp .env.example .env    # then set BETTER_AUTH_SECRET: openssl rand -base64 48
pnpm db:up              # Postgres 18 with pgvector, on port 5434
pnpm db:migrate         # creates the database and applies the migrations
pnpm db:seed            # Hermanus, its sources, tenants and users; prints the API keys once
pnpm cli:captures       # loads the captured Hermanus pages in data/hermanus through the pipeline
pnpm dev                # the API on port 4000 and the web app on port 3000
```

Keep the keys the seed prints: they are stored only as a hash and are not shown again. Running the seed again issues
none for a user that already has them.

For real data, set these in `.env` too:

- `ANTHROPIC_API_KEY`, for the language model. `pnpm cli:captures` asks it only when a match is unsure, and never with
  `--no-model`. Fetching the live sources needs it for every listing.
- `AWS_REGION` and AWS credentials, for the embedding model on Amazon Bedrock. Without them, search orders by keyword
  alone.

`pnpm cli:pipeline run` fetches the live sources instead, then processes and embeds what it found. The server does the
same by itself: once it is listening, its scheduler fetches every active source that is due, so it calls the sources'
websites and the language model with no one asking. The commands are in [apps/cli](apps/cli/README.md).

## Scripts

| Script | Does |
| --- | --- |
| `pnpm dev` | Runs the API and the web app in watch mode |
| `pnpm build` | Checks the types of every project and builds the web app |
| `pnpm typecheck` | Checks the types of every project |
| `pnpm lint` | Runs ESLint in every project, which also checks the architecture rules |
| `pnpm test` | Runs the tests of every project, one project at a time |
| `pnpm db:up`, `pnpm db:down` | Starts and stops Postgres in Docker |
| `pnpm db:migrate`, `pnpm db:migrate:test` | Applies the migrations to the development and the test database |
| `pnpm db:generate` | Generates a migration from a change to the schema |
| `pnpm db:seed`, `pnpm db:seed:samples` | Seeds the default data, and the default data with sample experiences |
| `pnpm db:studio` | Opens Drizzle Studio |
| `pnpm cli:pipeline <command>` | Runs the pipeline by hand: `discover`, `process`, `embed`, `run`, `refetch` or `reprocess` |
| `pnpm cli:captures` | Loads the captured pages in `data/hermanus` through the pipeline |
| `pnpm tunnel` | Opens a Cloudflare quick tunnel to the API on port 4000, for Claude to reach it |

The arguments go straight after the script name, with no `--`: `pnpm cli:pipeline discover --source "Hermanus Times"`.

The database tests use the database in `TEST_DATABASE_URL`, which they create, migrate and empty themselves. Never
point it at a database you want to keep.

## Connecting Claude

Claude Code on the same machine connects to `http://localhost:4000/mcp` with an API key. Claude on claude.ai, Claude
Desktop or mobile connects from Anthropic's cloud, so the server must be reachable at a public HTTPS address, which
`pnpm tunnel` gives a local one. The steps are in [apps/api: Connecting Claude](apps/api/README.md#connecting-claude).

## Continuous integration

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and every pull request. It installs with the
pnpm version in `packageManager` and a frozen lockfile, on the Node version in `engines`, then runs `pnpm lint`,
`pnpm typecheck` and `pnpm test` as separate steps, for every project. The tests run against a Postgres service with
pgvector, the same image as `docker-compose.yml`, and need no model key: the language model and the embedding model are
fakes in the tests. A newer push to the same branch cancels the run still going.

## Workflow

Large changes are made in a separate git worktree with a clean install, committed as they go, and squash-merged into
`main` only when asked. See [AGENTS.md](AGENTS.md).
