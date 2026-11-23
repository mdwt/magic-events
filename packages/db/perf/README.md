# Performance measurement

Scripts that build a database large enough to show a bad plan, start the API on it with no jobs, and time a client's
requests. Use databases of their own, named `magic_events_perf*`, never the development or a test database.

## Build the databases

```sh
export PERF_DATABASE_URL=postgres://magic:magic@localhost:5434/magic_events_perf
DATABASE_URL=$PERF_DATABASE_URL pnpm --filter @magic-events/db migrate
DATABASE_URL=$PERF_DATABASE_URL pnpm --filter @magic-events/cli seed        # keep the printed API keys
DATABASE_URL=$PERF_DATABASE_URL pnpm --filter @magic-events/cli captures --no-model
psql "$PERF_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/perf/embed-random.sql
# The real-size copy, before multiplying:
psql postgres://magic:magic@localhost:5434/postgres -c "create database magic_events_perf_small template magic_events_perf"
# The large one: about 100,000 experiences, 2.8 million sessions, 49 locations (takes about two minutes):
psql "$PERF_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/perf/multiply.sql
psql "$PERF_DATABASE_URL" -f packages/db/perf/counts.sql
```

`multiply.sql` takes `-v copies=440 -v home_copies=40`. It ends with `vacuum analyze`.

## Measure

```sh
# Log every statement with its time, for --trace:
psql postgres://magic:magic@localhost:5434/postgres -c "alter database magic_events_perf set log_min_duration_statement = 0"
DATABASE_URL=$PERF_DATABASE_URL API_PORT=4100 API_HOST=127.0.0.1 API_ALLOWED_HOSTS=127.0.0.1,localhost \
  LOG_LEVEL=debug LOG_PRETTY=false node --env-file-if-exists=.env packages/db/perf/serve.mjs
PERF_KEY=mev_... node packages/db/perf/bench.mjs 7                   # median and worst of 7 runs per scenario
PERF_KEY=mev_... node packages/db/perf/bench.mjs 7 changes           # only the scenarios whose name has "changes"
PERF_KEY=mev_... node packages/db/perf/bench.mjs 1 x --trace search  # the statements each one runs, with times
```

A search with a query text waits for the query's embedding from Bedrock, so it needs AWS credentials in `.env`.

```sh
# Many callers at once: 10 callers for 8 seconds. One key allows API_KEY_RATE_LIMIT_MAX requests a minute.
PERF_BASE=http://127.0.0.1:4100 PERF_KEY=mev_... node packages/db/perf/load.mjs 10 8
# serve.mjs with another pool size than createDb's default of 10:
PERF_POOL=20 DATABASE_URL=$PERF_DATABASE_URL API_PORT=4102 ... node --env-file-if-exists=.env packages/db/perf/serve.mjs
# The writes and the background work through the services: saves, match candidates, a discovery run, the upkeep,
# the embedding job (a stand-in model), onboarding and the key check. It writes to the database, as the jobs would.
PERF_CONTAINER=magic-events-postgres-1 PERF_KEY=mev_... DATABASE_URL=$PERF_DATABASE_URL \
  node --env-file-if-exists=.env packages/db/perf/services.mjs [step name]
```
