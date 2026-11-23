# Domain events

Source of truth for how domain events are named and stored, and which ones the system defines. Resources are defined in [data-model.md](data-model.md).

2026-11-23 · Meiring

## Naming

A domain event is named `resource.verb`, all lowercase.

- `resource` is the resource the event is about, in the domain that raises it. A multi-word resource uses an underscore: `raw_listing`.
- `verb` is in the past tense, because a domain event records something that already happened: `created`, `processed`, `suspended`. A multi-word verb uses an underscore: `role_changed`.
- The name is the `type` column in the `events` log.

## Envelope

Every domain event is one row in the repo's append-only `events` table.

| Column | Holds |
| --- | --- |
| `global_position` | Order across all domain events. Readers keep their place by it |
| `id` | The domain event's own ID |
| `stream_id` | The resource the event is about, as `resource:<id>`, for example `experience:7f3c…` |
| `stream_version` | The resource's version after this event. Unique per stream, so two writers cannot both append version 5 |
| `type` | The name, for example `experience.processed` |
| `data` | The payload, below |
| `metadata` | Who or what caused it: the user or agent, the tenant, the request or run, and the domain event that led to it, if any |
| `recorded_at` | When it was appended |

## Domain events in the prototype

Nothing in the prototype reads domain events. Domains call each other's services, and the hand-off from fetching to processing is the raw listing's status (see [discovery.md](discovery.md)). Whether these are appended to `events` as an audit trail is an open question in [data-model.md](data-model.md).

| Domain event | Raised by | When | Carries |
| --- | --- | --- | --- |
| `location.added` | Catalogue | The system starts covering a new location | Location ID, name, slug, country, region, timezone, centre point |
| `raw_listing.captured` | Discovery | A run saves a listing that is new or has changed | Raw listing ID, run ID, source, the source's listing ID, address, fetched time, content type |
| `experience.processed` | Data processing | A raw listing produced a new or changed experience | Experience ID, version, raw listing ID |
| `tenant.created` | Organizations | A tenant is set up | Tenant ID, name, slug, kind |
| `tenant.suspended` | Organizations | A tenant loses access | Tenant ID, reason |
