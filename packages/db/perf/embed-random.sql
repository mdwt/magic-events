-- Gives most experiences a random unit vector as their embedding, from the current model, so a search with a query
-- text works out the cosine distance for real. Nine in ten of those with none get one.
--
--   psql "$PERF_DATABASE_URL" -v model=amazon.titan-embed-text-v2:0 -f packages/db/perf/embed-random.sql

\if :{?model}
\else
  \set model 'amazon.titan-embed-text-v2:0'
\endif

create or replace function perf_random_vector() returns vector
language sql volatile as $$
  select l2_normalize(array_agg(random()::real - 0.5)::vector) from generate_series(1, 1024)
$$;

update experience
set embedding = perf_random_vector(), embedding_model = :'model', embedding_failures = 0
where embedding is null and random() < 0.9;
