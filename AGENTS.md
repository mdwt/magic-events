# magic-events

A multi-tenant API system that finds, processes and serves experiences by location. Travel agencies and travel apps are the tenants. Their people and their AI agents query the same feed, through a REST API and an MCP interface, to plan trips.

## The brief

A travel agent planning a trip wants to know what is on in a place while their traveller is there: a festival, a concert, a big match, a market. Build a first version of a feed that collects those events for Hermanus, South Africa, so that the people and the agents planning trips can use it.

### How it gets used

- A luxury trip is usually booked 6 to 18 months before it starts.
- Closer to the date the trip is refined and activities are booked, so a planner looks at the same place more than once, months apart.
- Travellers vary widely in age and interests, so what is worth knowing about differs from one trip to the next.

What else the feed needs to be is for you to decide.

### What counts as an event

| Kind | Examples |
| --- | --- |
| Something to go to | J. Cole in Johannesburg on 12 December 2026, Lions v Munster at Ellis Park on 17 April 2027, the Hermanus Country Market on a Saturday |
| Something that runs | A theatre show with 81 dates, an exhibition that is open for a year |
| Something months away | The FynArts Festival in Hermanus in June 2027 |
| A season, which has months and no date | Southern right whales off Hermanus, June to November |

## Architecture principles

### Domain-driven design on a hexagonal architecture, kept light

The system is organised into domains, and each domain uses ports and adapters. These are the principles the system is built on, and this is version 1, so they are applied without overdoing them:

- The goal is the cleanest and simplest data model that gives a functional version 1.
- A context or service may depend on another context and call its service for the data it needs.
- Never add a workaround to the data model to keep contexts apart: no copied data, no synced tables, no duplicated fields.

### Guard against over-engineering

The system is built to be scalable, but the first goal is a proven, working version 1. Do not add a dependency until version 1 is proven and the dependency is needed.

### Static analysis enforces architectural integrity

The rules are few, and the ones that exist are enforced. Linters and static analysis check the architectural rules, so that integrity is maintained by tooling and not by convention.

## Workflow

Large changes and feature implementations are done in a separate git worktree:

- No symlinks to the original checkout. Run a clean install inside the worktree.
- Do the full implementation in the worktree.
- Commit as you go.
- Merge back into `main` only when prompted. Every merge into `main` is a squash merge.
- After merging, delete the branch and remove the worktree.
