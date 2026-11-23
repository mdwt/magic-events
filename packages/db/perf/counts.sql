-- The size of the catalogue and its neighbours, one row per table.
select 'location' as "table", count(*) from location
union all select 'experience', count(*) from experience
union all select 'experience with embedding', count(*) from experience where embedding is not null
union all select 'experience_session', count(*) from experience_session
union all select 'experience_attribute_value', count(*) from experience_attribute_value
union all select 'experience_tag', count(*) from experience_tag
union all select 'experience_source_link', count(*) from experience_source_link
union all select 'experience_change', count(*) from experience_change
union all select 'source', count(*) from source
union all select 'run', count(*) from run
union all select 'listing', count(*) from listing
union all select 'raw_listing', count(*) from raw_listing
union all select 'raw_listing pending', count(*) from raw_listing where status = 'pending'
union all select 'events', count(*) from events
union all select 'tenant', count(*) from tenant
union all select 'user', count(*) from "user"
union all select 'apikey', count(*) from apikey;
