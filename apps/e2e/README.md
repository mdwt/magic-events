# @magic-events/e2e

The end-to-end suite: a repeatable, black-box run of every scenario in
[docs/end-to-end.md](../../docs/end-to-end.md) that needs no person, against the real server over real HTTP, as its
clients call it, with a check of the server's log after each one. It imports nothing from the system: it knows it only
through REST, MCP (the official SDK's client over Streamable HTTP), the command-line tools run as child processes, the
captured files and the log.

```sh
pnpm e2e         # everything that needs no person and no outside service
pnpm e2e:live    # adds the scenarios that call real websites, the language model and Bedrock, with the keys in .env
```

Needs Postgres up on port 5434 (`pnpm db:up`), `psql` on the path, and an installed workspace.

## What a run does

1. Drops and creates its own database, `magic_events_e2e`, migrates it twice and seeds it twice with the real commands,
   and keeps the keys the seed prints as the run's clients.
2. Copies `data/hermanus` to a temporary folder and loads it with `captures --no-model`, so the catalogue is
   deterministic and no language model is called.
3. Starts `apps/api/src/server.ts` on a free port with `LOG_LEVEL=debug`, its output in a log file, schedules that do not
   fire during the run, and no model key or AWS settings, so a query text orders by keyword alone.
4. Runs each scenario as a test named by its ID, then a second test that reads the server's lines for it: a start and
   a completed line per request with the same request ID the client got, who is calling on every line after
   authentication, a refusal at warn with its reason, a system error at error with the error.
5. Calls every operation of `apps/api/openapi.json` in each documented answer it can cause, checks each answer against
   its schema, and starts extra servers for the rate limits and for a database that goes away (a TCP proxy in front of
   Postgres, so no other database is touched).
6. Stops the servers, drops its database, removes its files, and writes the results table to `results/latest.md`.

| Variable | Does |
| --- | --- |
| `E2E_KEEP=1` | Keeps the database and the temporary folder with the logs, to look into a failure |
| `E2E_SKIP_CHECKS=1` | Leaves out C-02 and C-03, the workspace's type checks, lint, build and tests, which take longest |

The run exits non-zero when any scenario or its log check failed. It is not part of `pnpm test` or CI.
