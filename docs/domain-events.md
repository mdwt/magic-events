# Domain events

Source of truth for what a domain event is, how one is named and stored, and which ones version 1 defines. Raw listings are defined in [discovery.md](discovery.md) and experiences in [data-model.md](data-model.md).

2026-11-23 · Meiring

## What a domain event is

A domain event is a stored record that something happened in the system: a raw listing was captured, an experience was published. It is not an experience. "Event" on its own always means domain event.

In version 1 the domain events are a record of what happened. They answer, in one place, what happened to a raw listing or an experience, and when. Nothing reads them to do work: domains call each other's services, and the hand-off from fetching to processing is the raw listing's status (see [discovery.md](discovery.md)).

## Naming

A domain event is named `resource.verb`, all lowercase.

- `resource` is the resource the event is about. A multi-word resource uses an underscore: `raw_listing`.
- `verb` is in the past tense, because a domain event records something that already happened: `captured`, `published`. A multi-word verb uses an underscore.

## The log

Every domain event is one row in the `events` table.

| Column | Holds |
| --- | --- |
| `id` | The domain event's own ID |
| `type` | The name, for example `experience.changed` |
| `resource_id` | The ID of the resource the event is about: the raw listing or the experience. The `type` says which |
| `data` | What happened, as JSON. The Carries column below lists it for each domain event |
| `recorded_at` | When it was appended |

- **Append-only.** A row is never changed or deleted.
- **Written with the change.** A domain event is appended in the same transaction as the change it records. If the change rolls back, so does the domain event, so the log never disagrees with the tables.
- **Written by the domain that makes the change.** That domain's repository appends the row. The `events` table belongs to no domain, and no domain reads it.
- **No copy of the resource.** A domain event carries IDs and what happened. The detail stays on the raw listing row and on the experience's change row.

An example:

```json
{
  "id": "0c9e41d2-…",
  "type": "experience.changed",
  "resource_id": "7f3c88a0-…",
  "data": { "version": 4, "change": "rescheduled", "raw_listing_id": "b21a5e07-…" },
  "recorded_at": "2026-11-23T08:14:07Z"
}
```

## Domain events in version 1

Version 1 defines six domain events, all for sourcing and processing experiences. Locations, tenants and users raise none.

| Domain event | Raised by | When | Carries |
| --- | --- | --- | --- |
| `raw_listing.captured` | Discovery | A run saves a raw listing: for a listing that is new, has changed, or is gone from its source | Listing ID, run ID, raw listing kind (listing or removed) |
| `raw_listing.processed` | Discovery | Data processing marks the raw listing processed. This includes a raw listing that nothing was extracted from, and one of kind removed | Listing ID |
| `raw_listing.failed` | Discovery | Data processing marks the raw listing failed. One per failed attempt | Listing ID, the error, the attempt number, whether it will be retried |
| `raw_listing.superseded` | Discovery | An older version that is still pending or failed is set to Superseded, because the listing has a newer version | Listing ID, the raw listing ID of the newer version |
| `experience.published` | Catalogue | An experience is saved for the first time, as version 1 | Version, raw listing ID |
| `experience.changed` | Catalogue | An experience gets a new version, whatever caused it: a changed listing, its last source link being removed, its last date passing, its booking closing | Version, the change kind from the experience's change row, and the raw listing ID when processing a raw listing caused it |

- **A raw listing** gets one `raw_listing.captured` when it is saved. After that it gets one `raw_listing.failed` for each attempt that fails and one `raw_listing.processed` each time it is processed, or one `raw_listing.superseded` if a newer version replaces it first.
- **An experience** gets exactly one domain event per version: `experience.published` for version 1 and `experience.changed` for each version after it. An update that changes nothing makes no version and no domain event.
- **Data processing raises none itself.** What it does shows up through the two services it calls: Catalogue appends the experience domain events when it saves, and Discovery appends `raw_listing.processed` or `raw_listing.failed` when the raw listing is marked.
- One raw listing is processed in one transaction (see [data-processing.md](data-processing.md)), so the experience domain events it causes and its `raw_listing.processed` are appended together or not at all.

## Decisions

| Decision | |
| --- | --- |
| Purpose | A record of what happened. Nothing reads the log to do work, and no hand-off depends on it |
| Names | `resource.verb`, lowercase, verb in the past tense |
| The log | One append-only `events` table with five columns: `id`, `type`, `resource_id`, `data`, `recorded_at`. It keeps no positions and no per-resource version numbers, because nothing reads it in order |
| Writing | In the same transaction as the change, by the repository of the domain that makes the change |
| Payload | IDs and what happened. No copy of the resource |
| Domain events defined | Six: `raw_listing.captured`, `raw_listing.processed`, `raw_listing.failed`, `raw_listing.superseded`, `experience.published`, `experience.changed` |
| Raw listing domain events | Raised by Discovery, one for each status a raw listing is given |
| Experience domain events | Raised by Catalogue, one per version, because only Catalogue knows whether a save really changed the experience |
