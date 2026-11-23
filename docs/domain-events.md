# Domain events

Source of truth for the domain events the system raises: their names, who raises and reads each one, and what each one carries. Resources are defined in [data-model.md](data-model.md).

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

## Catalogue

| Domain event | When | Read by | Carries |
| --- | --- | --- | --- |
| `location.added` | The system starts covering a new location | Discovery | Location ID, name, slug, country, region, timezone, centre point |
| `submission.created` | An organiser submits a new experience or a change to one | Data processing | Submission ID, tenant ID, experience ID (empty for a new experience), the submitted details |

## Discovery

| Domain event | When | Read by | Carries |
| --- | --- | --- | --- |
| `raw_listing.captured` | A run saves a listing that is new or has changed since the last copy | Data processing | Raw listing ID, run ID, source, location ID, the source's listing ID, address, fetched time, content type, the content or a reference to it |

## Data processing

| Domain event | When | Read by | Carries |
| --- | --- | --- | --- |
| `experience.processed` | A listing or submission produced a new or changed experience | Catalogue | Experience ID, version, all published fields, sessions, attribute values, tags, source links, and the submission ID if a submission caused it |
| `incoming_listing.rejected` | A listing or submission could not become an experience | Catalogue | Incoming listing ID, origin (discovery or submission), origin ID, reason |

## Organizations

| Domain event | When | Read by | Carries |
| --- | --- | --- | --- |
| `tenant.created` | A tenant is set up | Identity | Tenant ID, name, slug, kind |
| `tenant.suspended` | A tenant loses access | Identity | Tenant ID, reason |
| `user.added` | A person joins a tenant with a role | Identity | User ID, tenant ID, role |
| `user.role_changed` | A user's role changes | Identity | User ID, tenant ID, old role, new role |
| `user.removed` | A user leaves a tenant | Identity | User ID, tenant ID |

## Renamed from spec Rev 1

| Spec Rev 1 | Now |
| --- | --- |
| LocationAdded | `location.added` |
| RawRecordCaptured | `raw_listing.captured` |
| ExperienceSubmitted | `submission.created` |
| ExperienceProcessed | `experience.processed` |
| TenantCreated | `tenant.created` |
| TenantSuspended | `tenant.suspended` |
| UserAdded | `user.added` |
| RoleChanged | `user.role_changed` |
| UserRemoved | `user.removed` |

`incoming_listing.rejected` is new. Without it, Catalogue has no way to learn that a submission was rejected, which its Rejected status needs.
