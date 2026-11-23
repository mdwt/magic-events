# Rev 1: Domains, architecture and use cases

2026-11-23 · Meiring

## System overview

The system is a multi-tenant platform that finds, processes and serves experiences by location. Travel businesses query it to plan trips. Clients only read; they cannot create or change experiences. Clients reach it through a REST API and an MCP interface. This revision defines the domains, their boundaries and the main use cases, and makes no technology choices.

Version 1 is an experience feed. It holds no trip context and serves experiences from the search parameters the client sends.

| Capability | What it means | Owning domain |
| --- | --- | --- |
| Discover experiences | Find experiences in the locations the system covers and capture the raw data as received | Discovery |
| Process experiences | Clean, de-duplicate, categorise and tag raw data, then make it ready for the data warehouse | Data processing |
| Search experiences | Find processed experiences by location, dates and traveller interests | Catalogue |
| Track changes | Show what is new, changed or cancelled since a time the client gives | Catalogue |
| Authenticate and authorise | Know who is calling and decide what they may do | Identity |
| Manage tenants | Tenant setup and configuration, users, and their roles | Organizations |

## Actors and roles

Version 1 has two roles. Every person or agent that calls the system acts as one of them.

| Role | Kind | Who holds it | What they can do |
| --- | --- | --- | --- |
| System admin | System role | The platform operator | Onboard and configure tenants, manage users and roles, manage locations and sources, oversee discovery and processing |
| Client | User role | Users of a client tenant | Search experiences and track changes |

Client tenants come in several kinds. All of them hold the client role, and they use the system differently:

- **Travel agencies and travel agents** search for experiences to plan trips for their travellers.
- **Travel apps** search experiences on behalf of their own users.

A client can call through the REST API, or through MCP using an AI agent acting for that client. Both paths carry the same identity, tenant and role. Agents can do exactly what clients can and have no separate role. Identity knows whether a caller is an agent or a person.

## Domains

There are five domains: Discovery, Data processing, Catalogue, Identity and Organizations. Catalogue owns the processed experiences that clients search and track changes on. Each domain owns its own data, and no other domain changes that data directly.

### Discovery

Finds experiences and captures the raw data as received.

- **Owns:** sources (where experiences are found), which sources cover which location, discovery runs, raw records exactly as fetched.
- **Boundary:** does not interpret, categorise or decide what clients see. It hands raw records to Data processing and stops there.

### Data processing

Turns raw records into clean, categorised, tagged experiences ready for the data warehouse.

- **Owns:** the processing pipeline, the category and tag vocabulary, matching rules (is this the same experience as one we already have), and the processed result.
- **Boundary:** does not fetch from sources or answer client queries. It processes the raw listings Discovery captures.

### Catalogue

The experiences as clients see them, and everything clients do with them.

- **Owns:** published experiences, the locations the system covers and clients search by, search by location, dates and interests, and the change history clients track.
- **Boundary:** does not process or categorise. Every experience it publishes comes from Data processing.

All experiences are discoverable by every tenant.

### Identity

Knows who is calling and decides what they may do.

- **Owns:** credentials for people and for agents calling through MCP, whether each caller is an agent or a person, authentication, and authorisation decisions.
- **Boundary:** does not decide who belongs to which tenant or which role they hold. It reads that from Organizations and turns it into an allow or deny on each request.

### Organizations

The tenants and the people in them.

- **Owns:** tenants, tenant kind (travel agency, travel app), tenant configuration, users, membership and role assignment.
- **Boundary:** does not authenticate anyone or hold credentials. It does not hold experiences.

## Architecture

The API uses ports and adapters. Each domain defines inbound ports for what it offers and outbound ports for what it needs, with no technology in either. Adapters connect those ports to the outside world, and an adapter can be swapped without changing the domain.

```mermaid
flowchart TB
  subgraph Inbound adapters
    SCH[Scheduler]
    REST[REST API]
    MCP[MCP]
  end
  ID[Identity: authenticates and authorises every call]
  subgraph Application core
    DIS[Discovery]
    DP[Data processing]
    CAT[Catalogue]
    ORG[Organizations]
  end
  subgraph Outbound adapters
    SRC[Experience sources]
    DW[Data warehouse]
    STO[Storage]
  end
  REST --> ID
  MCP --> ID
  ID --> CAT
  ID --> ORG
  SCH --> DIS
  DIS --> DP
  DP --> CAT
  DIS --> SRC
  DP --> DW
  CAT --> STO
  ORG --> STO
```

REST and MCP are two adapters on the same inbound ports, so a person and an agent get identical behaviour. The scheduler starts discovery without passing through Identity, because no client is involved.

| Domain | Inbound ports (what it offers) | Outbound ports (what it needs) |
| --- | --- | --- |
| Discovery | Run discovery for a location; manage sources and which locations each covers | Fetch from a source; store raw records; announce `raw_listing.captured` |
| Data processing | Process a raw record | Store processed experiences; load the data warehouse; announce `experience.processed` |
| Catalogue | Search experiences; get changes since; manage locations | Store published experiences and their history; announce `location.added` |
| Identity | Authenticate a caller; authorise an action | Store credentials; know each user's tenant and role |
| Organizations | Manage tenants; manage users and roles | Store tenants and users; announce tenant and user changes |

## How domains talk

Domains never reach into each other's data. One domain raises a domain event when something happens, and the domains that care keep their own copy of what they need.

| Domain event | Raised by | Listened to by | Means |
| --- | --- | --- | --- |
| `location.added` | Catalogue | Discovery | A new place is covered; start finding experiences there |
| `raw_listing.captured` | Discovery | Data processing | A source returned an experience record, as fetched |
| `experience.processed` | Data processing | Catalogue | A clean, categorised, tagged experience is ready, either new or changed |
| `tenant.created` | Organizations | Identity | A new tenant exists and can have users |
| `user.added` | Organizations | Identity | A person joined a tenant with a role; issue credentials |
| `user.role_changed` | Organizations | Identity | A user's role changed; update what they may do |
| `user.removed` | Organizations | Identity | Revoke that user's access |
| `tenant.suspended` | Organizations | Identity | Revoke access for everyone in the tenant |

## Use cases

Each step names the domain that does it, so you can see where every responsibility sits.

### UC1: A travel agent sources experiences for a luxury trip

A travel agent is planning a trip to Hermanus from 10 to 20 June 2027 for a couple who like art and nature. They ask the system what is on while the couple is there.

1. The agent calls through REST, or their AI agent calls through MCP.
2. **Identity** authenticates the caller, then authorises the search for a client in an active tenant.
3. **Catalogue** finds published experiences in Hermanus that overlap 10 to 20 June 2027 and match art or nature. That includes single dates, recurring markets, festivals and seasons such as whale watching.
4. **Catalogue** returns the experiences with their categories, tags, dates and how certain those dates are.

### UC2: The travel agent checks back months later

Eight months later, the agent refines the trip and books activities. They want only what changed.

1. **Identity** authenticates and authorises the caller, as in UC1.
2. **Catalogue** takes the same search parameters and the time of the agent's last search.
3. **Catalogue** returns what is new, rescheduled, changed or cancelled since then.

### UC3: The system discovers experiences in a location

1. **Discovery** runs on its schedule for each covered location and fetches from that location's sources.
2. **Discovery** stores each raw record as received and raises `raw_listing.captured`.
3. **Data processing** cleans and de-duplicates the records, categorises and tags them, prepares them for the data warehouse, and raises `experience.processed`.
4. **Catalogue** publishes new experiences and records changes to existing ones, which feeds UC2.

### UC4: A system admin onboards a travel agency

1. **Identity** authenticates the system admin and authorises tenant management.
2. **Organizations** creates the tenant as a travel agency, sets its configuration, and raises `tenant.created`.
3. **Organizations** adds the agency's first user with the client role and raises `user.added`.
4. **Identity** issues that user's credentials for REST and MCP.

## Glossary

| Term | Meaning |
| --- | --- |
| Experience | Something a traveller can go to or do: a concert, a match, a market, a show with many dates, an exhibition, a festival months away, or a season such as whale watching |
| Domain event | Something that happened inside the system that another domain may care about, such as `experience.processed`. Not an experience. |
| Raw record | An experience as a source returned it, before any processing |
| Source | A place Discovery finds experiences, such as a ticketing site, tourism listing or venue page |
| Location | A place the system covers and clients search by, such as Hermanus |
| Tenant | A client organisation: a travel agency or travel app |
| Client | The user role. A person, or an agent acting for them, inside a tenant |
| System admin | The system role that operates the platform |
| Port | A domain's own definition of what it offers (inbound) or what it needs (outbound), with no technology in it |
| Adapter | A plug that connects a port to the outside world, such as REST, MCP, a scheduler, a source, storage or the data warehouse |

## Decisions

| Question | Decision |
| --- | --- |
| Is Catalogue its own domain? | Yes |
| Is a location a place the system covers or a tenant's site? | A place the system covers, owned by Catalogue |
| Can every tenant see every experience? | Yes. All experiences are discoverable by every tenant |
| Can clients create or change experiences? | No. Clients only read. Every experience comes from discovery |
| Do agents need their own role? | No. Agents can do exactly what clients can. Identity knows whether a caller is an agent or a person |
| Where does trip context live? | Nowhere in the system. It is an experience feed that serves experiences from the client's search parameters |
| How does a client search by place? | With a point and a radius the client chooses. Distance is worked out at query time |
| Where are sources managed? | In Discovery, which owns sources and which locations each covers |

## Open questions

- [ ] Does an agent's credential belong to a specific user or to the tenant? The MCP question was closed on roles, but this part is still unanswered, and no flow issues or revokes an agent credential.
- [ ] A source that marks an experience cancelled is covered: Data processing sets the status from the source. What happens when a listing disappears from its source without being marked cancelled?
- [ ] Who reads the data warehouse in v1? Data processing loads it, and Catalogue serves search from its own store.
- [ ] How long is change history kept? UC2 checks back eight months later.
