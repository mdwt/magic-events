# Domain events

Source of truth for how domain events are named and stored, and which ones the system defines. Resources are defined in [data-model.md](data-model.md).

2026-11-23 · Meiring

## Naming

A domain event is named `resource.verb`, all lowercase.

- `resource` is the resource the event is about. A multi-word resource uses an underscore: `raw_listing`.
- `verb` is in the past tense, because a domain event records something that already happened: `captured`, `processed`. A multi-word verb uses an underscore.
- The name is the `type` column in the `events` log.

## Envelope

Every domain event is one row in the repo's append-only `events` table.

| Column | Holds |
| --- | --- |
| `global_position` | Order across all domain events. Readers keep their place by it |
| `id` | The domain event's own ID |
| `stream_id` | The resource the event is about, as `resource:<id>`, for example `experience:7f3c…` |
| `stream_version` | The position of this event in its stream, starting at 1. Unique per stream, so two writers cannot both append version 5 |
| `type` | The name, for example `experience.processed` |
| `data` | The payload, below |
| `metadata` | What caused it: the run or the raw listing being processed, and the domain event that led to it, if any |
| `recorded_at` | When it was appended |

## Domain events in version 1

Version 1 defines domain events only for sourcing and processing experiences. Locations, tenants and users raise none.

Nothing reads them. Domains call each other's services, and the hand-off from fetching to processing is the raw listing's status (see [discovery.md](discovery.md)). Whether these are appended to `events` as an audit trail is an open question in [data-model.md](data-model.md).

| Domain event | Raised by | When | Carries |
| --- | --- | --- | --- |
| `raw_listing.captured` | Discovery | A run saves a raw listing: a listing that is new, has changed or was removed | Raw listing ID, listing ID, run ID, source, kind, fetched time, content type |
| `experience.processed` | Data processing | Processing a raw listing created or changed an experience. One per experience | Experience ID, version, raw listing ID |
