# @magic-events/core

The application core: the five domains, the ports they offer and need, the outbound adapters that implement those
ports, and the wiring that puts them together. The apps ([apps/api](../../apps/api/README.md) and
[apps/cli](../../apps/cli/README.md)) are its inbound sides: they call its services and hold no business rules.

## Domains

| Domain | Owns |
| --- | --- |
| `src/discovery/` | Sources, runs, listings and raw listings: what is fetched, exactly as fetched |
| `src/data-processing/` | The pipeline that turns raw listings into experiences, the attribute and tag definitions, seasons and matching |
| `src/catalogue/` | Published experiences, locations, search, embeddings, the change history and upkeep |
| `src/identity/` | Credentials, authentication and authorisation |
| `src/organizations/` | Tenants, users and their roles |

The boundaries, and which domain calls which, are in [docs/architecture.md](../../docs/architecture.md).

## Ports and adapters

Each domain has a `ports.ts` and a `service.ts`. The inbound port is the service's interface: what the domain offers
the apps and the other domains. The outbound ports are what it needs, such as its repository or a source fetcher.
Each domain has one service and one repository, except Identity, which uses Better Auth directly.

The ports that belong to no domain are in `src/shared/`: the language model, the job queue, domain events and
transactions, with the logger, settings and the clock.

| Port | Version 1 adapter |
| --- | --- |
| Storage, one repository per domain, and transactions | Postgres with Drizzle (`src/adapters/storage/`) |
| Identity's credentials | Better Auth with its API key plugin (`src/adapters/auth/better-auth.ts`) |
| Language model | Claude, through the Anthropic API (`src/adapters/language-model/anthropic.ts`) |
| Embedding model | Amazon Titan Text Embeddings V2, on Amazon Bedrock (`src/adapters/embedding/bedrock.ts`) |
| Job queue | pg-boss, on queues in the same database (`src/adapters/jobs/pg-boss.ts`) |
| Domain events | Node's event emitter, in one process (`src/adapters/events/node-events.ts`) |
| Source fetchers | RSS feed, PDF calendar and web page (`src/adapters/sources/`) |
| Settings | Environment variables (`src/adapters/settings/env.ts`) |
| Logger | pino (`src/adapters/logging/pino.ts`) |

## Rules

ESLint (`eslint.config.mjs`) checks the architecture rules of [docs/architecture.md](../../docs/architecture.md):

- A domain imports no adapter, no provider's SDK, no database client, no test helper and not the wiring.
- A domain calls another only through that domain's `ports.ts`, and only along the arrows in "How domains talk".
- Shared code imports no domain and no technology.
- An adapter imports the port it implements, never a service.
- Identity and Organizations may use Better Auth, the one exception.

## Wiring

`src/services.ts` is the one place adapters and services meet. `createServices({ settings, db, logger, overrides })`
builds every service on its adapters and returns them. The API and the command-line tools both call it, so they run the
same system. `overrides` puts a fake or a stand-in in place of the language model, the embedding model, the source
fetchers, the clock or the domain events.

`src/testing/` holds what tests use, here and in the apps: the harness, which builds the services on the test database,
and the fakes of the language model, the embedding model, the job queue and Catalogue.

## Using it from an app

The package exports its source files by path, with the extension:

```ts
import { createServices } from "@magic-events/core/services.ts";
import type { Catalogue } from "@magic-events/core/catalogue/ports.ts";
```

The apps' own lint rules say which paths each part of an app may import.

## Scripts

| Script | Does |
| --- | --- |
| `build`, `typecheck` | Checks the types |
| `lint` | Runs ESLint, with the rules above |
| `test` | Runs every test, one file at a time |

```sh
pnpm --filter @magic-events/core test
```

The database tests use `TEST_DATABASE_URL`, which the harness creates, migrates and empties itself, so never point it
at a database you want to keep. Postgres must be up (`pnpm db:up`). The tests call no provider: the models are fakes and
the source adapters fetch from a local server.
