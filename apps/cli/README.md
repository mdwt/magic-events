# @magic-events/cli

Command-line tools for the operator: tenants, users and keys, the seed, the pipeline run by hand, and the loader for
captured pages. The API is for clients and has no admin endpoints, so a system admin works here. Each command
reads its arguments, calls the services of [packages/core](../../packages/core/README.md) and prints what came back. It
holds no rules of its own.

## Layout

| Path | Holds |
| --- | --- |
| `src/seed/run.ts` | The seed command |
| `src/seed/seed.ts` | What the seed writes, through the domain services |
| `src/seed/data/` | The seed's data: Hermanus, its seasons and sources, the tenants and users, the sample experiences |
| `src/admin.ts` | The admin command: tenants, users and API keys |
| `src/pipeline.ts` | The pipeline command |
| `src/load-captures.ts` | The captures command |
| `test/` | `node:test` tests |

## Commands

Run from the repository root. The arguments go straight after the script name, with no `--`. Every command reads the
repository's `.env`.

| Command | Does |
| --- | --- |
| `pnpm cli:admin tenant create --name NAME --slug SLUG --kind travel_agency\|travel_app [--configuration JSON]` | Creates an active tenant, with its configuration as a JSON object |
| `pnpm cli:admin tenant list` | Lists every tenant, with its status and kind |
| `pnpm cli:admin tenant show --slug SLUG` | One tenant, with its users |
| `pnpm cli:admin tenant update --slug SLUG [--name NAME] [--status active\|suspended] [--configuration JSON]` | Changes a tenant. Suspended refuses its users until it is active again |
| `pnpm cli:admin user add --tenant SLUG --name NAME --email EMAIL` | Adds a client user to a tenant |
| `pnpm cli:admin key issue --user EMAIL --name NAME --kind person\|agent` | Issues an API key and prints it once. It cannot be shown again |
| `pnpm cli:admin key list --user EMAIL` | Lists a user's keys, enabled or revoked, never the keys themselves |
| `pnpm cli:admin key revoke --user EMAIL --key KEY_ID` | Revokes one key. The user's other keys keep working |
| `pnpm db:seed` | Seeds Hermanus, the attributes, tags, seasons and sources, the tenants and users, and their API keys. Prints each new key once |
| `pnpm db:seed:samples` | The same, then inserts a small set of sample experiences |
| `pnpm cli:pipeline discover` | Fetches every active source now |
| `pnpm cli:pipeline discover --due` | Fetches only the sources that are due |
| `pnpm cli:pipeline discover --source NAME` | Fetches one source, by its name |
| `pnpm cli:pipeline process [--limit N]` | Processes the pending raw listings |
| `pnpm cli:pipeline embed` | Embeds the experiences that need it, round after round |
| `pnpm cli:pipeline run` | Discovers, processes, then embeds |
| `pnpm cli:pipeline refetch --location SLUG` | Fetches every active source of a location now |
| `pnpm cli:pipeline refetch --source NAME` | Fetches one source now |
| `pnpm cli:pipeline refetch --listing ID` | Fetches the source that listing belongs to |
| `pnpm cli:pipeline reprocess --listing ID` | Sends one listing back for processing |
| `pnpm cli:pipeline reprocess --experience ID` | Sends every listing an experience was built from back. ID is its ID or its slug |
| `pnpm cli:pipeline reprocess --source NAME` | Sends every listing of a source back |
| `pnpm cli:pipeline reprocess --location SLUG` | Sends every listing of a location back |
| `pnpm cli:captures` | Loads every source in `data/hermanus/sources.json` through the pipeline |
| `pnpm cli:captures --source SLUG` | Loads one captured source, by its slug |
| `pnpm cli:captures --no-model` | Never asks the language model: an unsure match is left as two experiences |
| `pnpm cli:captures --dir DIR` | Loads a capture directory other than `data/hermanus` |

`admin` runs one command at a time and names a user by their email address. A failed command prints the reason and
exits with 1. `refetch` and `reprocess` take exactly one selector. Add `--now` to `reprocess` to process the listings straight away.

The seed and every load are safe to run again: the seed upserts and issues no key a user already has, and a capture that
has not changed saves nothing new.

## What calls the outside world

- `discover`, `refetch` and `run` fetch the sources' real websites.
- `process`, `run` and `reprocess --now` call the real language model (`ANTHROPIC_API_KEY`) for every raw listing.
- `embed` and `run` call the real embedding model on Amazon Bedrock (`AWS_REGION` and AWS credentials).
- `captures` fetches nothing. It answers the language model's extraction and classification from the captured files,
  and asks the real model only when a match is unsure, or for a pending raw listing that has no capture. `--no-model`
  stops even that. It does not embed: run `pnpm cli:pipeline embed`, or let the server's scheduler do it.
- The seed calls nothing outside the database.

## Captures

A capture directory holds `sources.json`, `raw/<slug>/` with one file per captured page (its first line is
`URL: <address>`), and `extracted/<slug>.json` with the experiences read from those pages. For each source the loader
saves the source row, runs it through Discovery with the captures in place of the fetch, and processes the raw listings
through Data processing. The sources it saves need the seeded location, so seed first.

When Data processing asks the language model which stored experience an extracted one is, the loader first answers
plainly, in `src/plain-match.ts`. It says "same" only when that is safe: once the words of the venues and of dates are
set aside, the two titles have the same words, or one only adds to the other and they are one dated experience at the
same place starting the same day. Titles that each name something of their own, such as two operators' whale watching
trips from New Harbour, and a recurring experience that only one title adds to, are unsure. An unsure pair is asked of
the real model; with `--no-model` it is left as two experiences and never merged. The summary names every plain match.

## Scripts

| Script | Does |
| --- | --- |
| `seed`, `seed:samples` | The seed, as above |
| `admin`, `pipeline`, `captures` | The commands, as above |
| `build`, `typecheck` | Checks the types |
| `lint` | Runs ESLint |
| `test` | Runs the tests, against `TEST_DATABASE_URL` |
