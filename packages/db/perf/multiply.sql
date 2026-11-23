-- Multiplies a real-size catalogue into what a few years and a few dozen locations would look like, so that a bad
-- plan shows. Run it once, on a database of its own that has been migrated, seeded, loaded with the captures and
-- given embeddings (see README.md in this directory). Never on a database anyone else uses.
--
--   psql "$PERF_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/perf/multiply.sql
--
-- What it makes, from the experiences already there (the originals, in one location):
--   * 48 more locations: three within 50 km of the first location, and 15 clusters of three around the world.
--   * :copies copies of every original experience. The first :home_copies stay in the first location, so it is the
--     location with many experiences; the rest are spread over the new ones. Each copy is moved by whole weeks, from
--     three years back to a year ahead, so most of the catalogue is Past, as after years of running. An open-ended
--     recurring experience is not moved: it is still on. One copy in 25 is Cancelled and one in 25 Removed.
--   * Their sessions, attribute values, tags and source links, copied; nine in ten get a random embedding.
--   * Change rows: New, up to three Changed, one in ten Rescheduled with the sessions it had before, and Past,
--     Cancelled or Removed at the end.
--   * Every source again in every new location, a year of daily runs for every source, a listing per copy of each
--     listing, two raw listings per listing (a few thousand of them pending), and the domain events of all of it.
--   * 500 tenants with 10 users each, and two API keys per user. The keys are not usable: only the seeded ones are.

\if :{?copies}
\else
  \set copies 440
\endif
\if :{?home_copies}
\else
  \set home_copies 40
\endif
\if :{?model}
\else
  \set model 'amazon.titan-embed-text-v2:0'
\endif

\timing on
set client_min_messages = warning;
select setseed(0.42);

create or replace function perf_random_vector() returns vector
language sql volatile as $$
  select l2_normalize(array_agg(random()::real - 0.5)::vector) from generate_series(1, 1024)
$$;

begin;

-- ---- Locations ----

create temp table perf_home as select * from location order by created_at limit 1;

insert into location (name, slug, country, region, timezone, latitude, longitude)
select 'Perf Town ' || i, 'perf-' || i, 'ZA', 'Perf', h.timezone,
  case when i <= 3 then h.latitude + 0.12 * i else -50 + ((i - 4) / 3) * 7 + ((i - 4) % 3) * 0.25 end,
  case when i <= 3 then h.longitude - 0.15 * i else -150 + ((i - 4) / 3) * 20 + ((i - 4) % 3) * 0.25 end
from generate_series(1, 48) as i, perf_home h;

-- ---- Copies ----

create temp table perf_copy as
select k,
  case when k <= :home_copies then (select id from perf_home)
       else (select id from location where slug = 'perf-' || (((k - :home_copies - 1) % 48) + 1)) end as location_id,
  7 * (((k * 37) % 210) - 156) as shift,
  case when k % 25 = 0 then 'cancelled' when k % 25 = 1 then 'removed' else 'normal' end as fate
from generate_series(1, :copies) as k;

create temp table perf_original as
select e.id, e.status, e.booking, e.recurrence_rule is not null and e.recurrence_end is null as open_ended,
  (select min(start_date) from experience_session s where s.experience_id = e.id) as first_start,
  (select max(end_date) from experience_session s where s.experience_id = e.id) as last_end
from experience e;

create temp table perf_experience as
select c.k, o.id as old_id, gen_random_uuid() as new_id, c.location_id,
  case when o.open_ended then 0 else c.shift end as shift, c.fate, o.status, o.booking, o.open_ended,
  o.first_start + case when o.open_ended then 0 else c.shift end as first_start,
  o.last_end + case when o.open_ended then 0 else c.shift end as last_end
from perf_copy c cross join perf_original o;

update perf_experience set status = case
    when not open_ended and last_end < current_date and status in ('expected', 'announced', 'confirmed') then 'past'
    when fate = 'cancelled' then 'cancelled'
    when fate = 'removed' then 'removed'
    else status end::experience_status;

alter table perf_experience add column created_at timestamptz;
update perf_experience set created_at = least(
  now() - interval '1 day' * (1 + random() * 20),
  coalesce(first_start, current_date)::timestamptz - interval '1 day' * (30 + random() * 300));

create index on perf_experience (old_id, k);
create index on perf_experience (new_id);
analyze perf_experience;

insert into experience (id, location_id, title, slug, summary, description, profile, type, status, booking, timezone,
  opening_hours, venue_name, venue_address, city, latitude, longitude, price_min, price_max, currency, on_sale_at,
  booking_closes_at, booking_url, image_url, recurrence_rule, recurrence_start, recurrence_end, recurrence_start_time,
  recurrence_end_time, recurrence_skipped, version, embedding, embedding_model, created_at, updated_at, page_url,
  embedding_failures)
select p.new_id, p.location_id, e.title, e.slug || '-p' || p.k, e.summary, e.description, e.profile, e.type, p.status,
  case when p.status in ('past', 'cancelled', 'removed') and e.booking <> 'none' then 'closed' else e.booking end,
  e.timezone, e.opening_hours, e.venue_name, e.venue_address, e.city,
  e.latitude - h.latitude + l.latitude, e.longitude - h.longitude + l.longitude,
  e.price_min, e.price_max, e.currency, e.on_sale_at + interval '1 day' * p.shift,
  e.booking_closes_at + interval '1 day' * p.shift, e.booking_url, e.image_url, e.recurrence_rule,
  e.recurrence_start + p.shift, e.recurrence_end + p.shift, e.recurrence_start_time, e.recurrence_end_time,
  (select array_agg(d + p.shift) from unnest(e.recurrence_skipped) as d), 1,
  case when random() < 0.9 then perf_random_vector() end, null, p.created_at, p.created_at, e.page_url, 0
from perf_experience p
join experience e on e.id = p.old_id
join location l on l.id = p.location_id
cross join perf_home h;

update experience set embedding_model = :'model' where embedding is not null and embedding_model is null;

insert into experience_session (experience_id, start_date, end_date, precision, start_time, end_time, label, status,
  sold_out, origin)
select p.new_id, s.start_date + p.shift, s.end_date + p.shift, s.precision, s.start_time, s.end_time, s.label,
  s.status, s.sold_out, s.origin
from perf_experience p join experience_session s on s.experience_id = p.old_id;

insert into experience_attribute_value (experience_id, attribute_key, value)
select p.new_id, a.attribute_key, a.value from perf_experience p join experience_attribute_value a on a.experience_id = p.old_id;

insert into experience_tag (experience_id, tag)
select p.new_id, t.tag from perf_experience p join experience_tag t on t.experience_id = p.old_id;

-- ---- Change rows ----

create temp table perf_change (experience_id uuid, kind change_kind, previous jsonb, changed_at timestamptz);

insert into perf_change select new_id, 'new', null, created_at from perf_experience;

-- Up to three plain changes over its life.
insert into perf_change
select p.new_id, 'changed', jsonb_build_object('listingIds', jsonb_build_array(gen_random_uuid())),
  p.created_at + (least(now(), coalesce(p.last_end, current_date)::timestamptz) - p.created_at) * random()
from perf_experience p, generate_series(1, 3) as n
where n <= abs(hashtext(p.new_id::text)) % 4 and least(now(), coalesce(p.last_end, current_date)::timestamptz) > p.created_at;

-- One in ten was rescheduled: its sessions were two weeks earlier before.
insert into perf_change
select p.new_id, 'rescheduled',
  jsonb_build_object('sessions', (
    select jsonb_agg(jsonb_build_object('startDate', (s.start_date - 14)::text, 'endDate', (s.end_date - 14)::text,
      'precision', s.precision, 'startTime', s.start_time, 'endTime', s.end_time, 'label', s.label,
      'status', s.status, 'soldOut', s.sold_out, 'origin', s.origin) order by s.start_date)
    from experience_session s where s.experience_id = p.new_id)),
  p.created_at + (least(now(), coalesce(p.last_end, current_date)::timestamptz) - p.created_at) * random()
from perf_experience p
where abs(hashtext(p.new_id::text || 'r')) % 10 = 0 and least(now(), coalesce(p.last_end, current_date)::timestamptz) > p.created_at;

insert into perf_change
select new_id, status::text::change_kind, jsonb_build_object('status', 'confirmed'),
  case when status = 'past' then (last_end + 1)::timestamptz + interval '1 hour'
       else created_at + (now() - created_at) * random() end
from perf_experience where status in ('past', 'cancelled', 'removed');

insert into experience_change (experience_id, version, kind, previous, changed_at)
select experience_id, row_number() over (partition by experience_id order by changed_at, kind), kind, previous, changed_at
from perf_change;

update experience e set version = c.version, updated_at = c.changed_at
from (select experience_id, max(version) as version, max(changed_at) filter (where kind <> 'past') as changed_at
      from experience_change group by experience_id) c
where c.experience_id = e.id and e.id in (select new_id from perf_experience);

-- ---- Discovery ----

create temp table perf_source as
select s.id as old_id, l.id as location_id, gen_random_uuid() as new_id
from source s cross join location l where l.slug like 'perf-%';

insert into source (id, name, kind, location_id, settings, credentials_setting, sync_state, priority,
  fetch_interval_hours, missed_runs_before_removal, max_processing_attempts, active)
select p.new_id, s.name, s.kind, p.location_id, s.settings, s.credentials_setting, s.sync_state, s.priority,
  s.fetch_interval_hours, s.missed_runs_before_removal, s.max_processing_attempts, s.active
from perf_source p join source s on s.id = p.old_id;

-- Each original source stands for itself in the first location.
insert into perf_source select s.id, s.location_id, s.id from source s where s.id not in (select new_id from perf_source);
create index on perf_source (old_id, location_id);

-- A year of daily runs for every source, older than the runs already there.
create temp table perf_run as
select s.id as source_id, d, gen_random_uuid() as id from source s, generate_series(1, 365) as d;
create index on perf_run (source_id, d);

insert into run (id, source_id, started_at, finished_at, status, complete, listings_found, listings_new_or_changed,
  listings_unchanged, error)
select r.id, r.source_id, (current_date - r.d)::timestamptz + interval '3 hours',
  (current_date - r.d)::timestamptz + interval '3 hours 2 minutes',
  case when random() < 0.05 then 'failed' else 'succeeded' end::run_status, true, 40, 2, 38, null
from perf_run r;

create temp table perf_listing as
select c.k, l.id as old_id, gen_random_uuid() as new_id, ps.new_id as source_id, c.fate
from perf_copy c
cross join listing l
join perf_source ps on ps.old_id = l.source_id and ps.location_id = c.location_id;
create index on perf_listing (old_id, k);

insert into listing (id, source_id, source_listing_id, url, first_seen_run_id, last_seen_run_id, fingerprint, state,
  created_at, updated_at)
select p.new_id, p.source_id, l.source_listing_id || '#p' || p.k, l.url,
  (select id from perf_run r where r.source_id = p.source_id and r.d = 300),
  (select id from perf_run r where r.source_id = p.source_id and r.d = case when p.fate = 'removed' then 30 else 1 end),
  md5(p.new_id::text), case when p.fate = 'removed' then 'removed' else 'listed' end::listing_state,
  now() - interval '300 days', now() - interval '1 day'
from perf_listing p join listing l on l.id = p.old_id;

insert into experience_source_link (experience_id, listing_id, created_at)
select pe.new_id, pl.new_id, pe.created_at
from experience_source_link sl
join perf_experience pe on pe.old_id = sl.experience_id
join perf_listing pl on pl.old_id = sl.listing_id and pl.k = pe.k
where pe.fate <> 'removed';

-- Two versions of every listing: the first, and the latest. A few thousand of the latest are pending.
create temp table perf_raw as
select gen_random_uuid() as id, p.new_id as listing_id, p.source_id, p.old_id as old_listing_id, v,
  (select id from perf_run r where r.source_id = p.source_id and r.d = case when v = 1 then 300 else 1 + (p.k % 200) end) as run_id,
  case when v = 1 then now() - interval '300 days' else now() - interval '1 day' * (1 + (p.k % 200)) end as fetched_at,
  case when v = 2 and random() < 0.03 then 'pending' else 'processed' end::raw_listing_status as status
from perf_listing p, generate_series(1, 2) as v;

insert into raw_listing (id, listing_id, run_id, kind, fetched_at, content_type, content, fingerprint, status, attempts)
select r.id, r.listing_id, r.run_id, 'listing', r.fetched_at, o.content_type, o.content, md5(r.id::text), r.status, 0
from perf_raw r
join lateral (select content_type, content from raw_listing x where x.listing_id = r.old_listing_id
              order by fetched_at desc limit 1) o on true;

insert into events (type, resource_id, data, recorded_at)
select 'raw_listing.captured', id, jsonb_build_object('listing_id', listing_id, 'run_id', run_id, 'kind', 'listing'), fetched_at
from perf_raw
union all
select 'raw_listing.processed', id, jsonb_build_object('listing_id', listing_id), fetched_at + interval '5 minutes'
from perf_raw where status <> 'pending'
union all
select case when c.kind = 'new' then 'experience.published' else 'experience.changed' end, c.experience_id,
  jsonb_build_object('version', c.version, 'change', c.kind), c.changed_at
from experience_change c where c.experience_id in (select new_id from perf_experience);

-- ---- Tenants, users and keys ----

insert into tenant (name, slug, kind, status)
select 'Perf Tenant ' || i, 'perf-tenant-' || i,
  case when i % 3 = 0 then 'travel_app' else 'travel_agency' end::tenant_kind,
  case when i % 20 = 0 then 'suspended' else 'active' end::tenant_status
from generate_series(1, 500) as i;

insert into "user" (id, name, email, email_verified, tenant_id, role)
select gen_random_uuid()::text, 'Perf User ' || t.slug || '-' || u, 'user' || u || '@' || t.slug || '.example.com',
  false, t.id, 'client'
from tenant t, generate_series(1, 10) as u where t.slug like 'perf-tenant-%';

insert into apikey (id, config_id, name, start, reference_id, prefix, key, enabled, rate_limit_enabled,
  rate_limit_time_window, rate_limit_max, request_count, created_at, updated_at, metadata)
select md5(random()::text), 'default', 'perf key ' || n, 'mev_xx', u.id, 'mev_', encode(sha256(random()::text::bytea), 'base64'),
  true, true, 60000, 10000, 0, now(), now(), case when n = 1 then '{"kind":"person"}' else '{"kind":"agent"}' end
from "user" u, generate_series(1, 2) as n where u.email like '%@perf-tenant-%';

commit;

vacuum analyze;
