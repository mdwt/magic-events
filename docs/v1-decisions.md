# Version 1 decisions to review

What version 1 leaves out, and why. Each of these is described somewhere in the documents and is not needed for the four use cases in [architecture.md](architecture.md), which are the success criteria. Each is written up here so the decision to leave it out can be reviewed, kept or reversed.

2026-11-23 · Meiring

| # | Left out of version 1 | Use cases it touches | Issue |
| --- | --- | --- | --- |
| 1 | The Quicket and Ticketmaster API adapters | None. UC3 sources Quicket another way | [28](issues.md) |
| 2 | Venue coordinates | UC1: the radius is less exact | [35](issues.md), [5](issues.md) |
| 3 | The next source taking over when the leading listing goes | None. UC3 keeps slightly stale values in one case | [37](issues.md) |
| 4 | MCP sign-in with OAuth | None. UC1, UC2 and UC4 use API keys | [4](issues.md) |
| 5 | A reader for the data warehouse | None | [15](issues.md) |

Sending a listing back to be processed again was on this list on the morning of 23 November. It was decided the same day and is built, as command-line commands (see Processing again in [data-processing.md](data-processing.md)).

## 1. The Quicket and Ticketmaster API adapters

**The situation.** [discovery.md](discovery.md) names five source kinds, each with its own adapter. Two of them use an API: Quicket and Ticketmaster. Both need a key, and there is no key for either.

**What version 1 does instead.**

- **Quicket** is fetched through its public search pages, as web pages, with no key. The events are in the pages' structured data. A check on 23 November returned about 28 Hermanus events and more for Stanford.
- **Ticketmaster** is not fetched. Its public site returns no events for Hermanus or the Overstrand, so its API would return none either.
- Both API sources are seeded as rows that are switched off. Switching one on gives a failed run that says its kind has no adapter.

**What it costs.**

- **A Quicket event on several dates becomes one long session.** The page's structured data gives one start and one end, so search returns such an event for the days in between ([issue 36](issues.md)).
- **The pages are a text search.** A search for "stanford" also returns events in Sandton. The language model leaves those out, which is a judgement and not a filter.
- **No field mapping.** Every Quicket page goes through the language model. The API's events would be mapped in code, with no model call for extraction.
- **No price tiers or ticket types** beyond what the page states.

**What building it needs.** A key for each API. For each, one adapter in Discovery and one field-mapping extractor in Data processing. For Quicket, an answer to whether its incremental runs are joined by a complete run now and then ([issue 21](issues.md)).

**To decide.** Whether Quicket's public pages are good enough for version 1, and whether Ticketmaster stays a source kind at all while it holds nothing for Hermanus.

## 2. Venue coordinates

**The situation.** An experience has an optional position of its own, the venue's coordinates, and radius search uses it. Listings almost never give coordinates, and the language model cannot know them, so extraction returns a venue's name, address and city, and no position.

**What version 1 does instead.** Search uses the location's centre for any experience that has no position ([issue 5](issues.md)). Every experience from the pipeline is therefore placed at the centre of Hermanus.

**What it costs.**

- **The radius cannot tell places apart.** An experience in Stanford, 25 kilometres away, is returned at distance 0 from Hermanus.
- **A search centred elsewhere misses them.** A search around Stanford with a small radius returns nothing, although Stanford experiences are in the catalogue.
- **The distance in a result is not the venue's distance.**

UC1 as written, a search within a radius around Hermanus, works. It is less exact than the result suggests.

**What building it needs.** Coordinates from somewhere:

- **From the page**, where its structured data carries them. Some Quicket and AllEvents.in pages do. This needs no new service.
- **From a geocoding service**, behind a new port, which turns a venue's name and address into a position. This is a new outside dependency and a new adapter.

**To decide.** Whether version 1 needs real venue positions, and if so which of the two ways.

## 3. The next source taking over when the leading listing goes

**The situation.** The same experience appears on several sources. [data-processing.md](data-processing.md) says its fields come from its highest-priority linked listing, and that when that link is removed, the next one takes over.

**What version 1 does instead.** The first half is built: a lower-priority listing only fills empty fields while a higher-priority one is linked. The second half is not: when the leading listing is removed, the experience keeps the values it has.

**What it costs.** One case. If the leading source drops an experience and a lower-priority source still lists it with different details, the experience shows the dropped source's details until the remaining listing next changes and is processed. From then on that listing leads.

**What building it needs.** When the leading link is removed, send the experience's remaining listings back for processing. Sending a listing back is built, and the automatic step can call the same code. Until then a system admin can do the same by hand, with `pipeline reprocess --experience`.

**Decided.** Not in version 1. The automatic step is for phase 2.

## 4. MCP sign-in with OAuth

**The situation.** The MCP specification's own way to sign in is OAuth 2.1: a client such as Claude connects by sending the user through a sign-in page, and no key is copied by hand. Better Auth has a plugin for it.

**What version 1 does instead.** REST and MCP authenticate the same way, with an API key sent as `Authorization: Bearer`. A key belongs to one user and is marked as a person's or an agent's. A system admin issues and revokes keys.

**What it costs.**

- **The MCP client must be able to send a header.** Clients that only connect through OAuth cannot connect.
- **A key has to reach each user by hand.**
- **No sign-in page and no consent step.** The system has no way for a user to sign in at all: there are no passwords and no sign-in endpoint.

**What building it needs.** A sign-in surface the system does not have today: Better Auth's own endpoints mounted on the server, a way for a user to prove who they are (a password or a sign-in provider), and the OAuth plugin on top. That is a larger change than the plugin alone, and it opens the first public, unauthenticated endpoints.

**To decide.** Whether API keys are enough for version 1's clients.

## 5. A reader for the data warehouse

**The situation.** After saving, Data processing appends each experience it saved to the data warehouse, a table in the same database. [architecture.md](architecture.md) leaves open who reads it.

**What version 1 does instead.** The rows are written: one per experience, per processing, with the experience as Catalogue saved it and the raw listing it came from. Nothing reads them. Search and changed-since are served from Catalogue's own tables.

**What it costs.** Nothing for the use cases. The table grows with every processing and has no retention rule.

**What building it needs.** A decision on what the warehouse is for: reporting, an export for a tenant, a history a planner can look at, or training data for classification.

**To decide.** Who reads it, or whether version 1 should write it at all.

## Also left out

Two smaller gaps of the same kind, recorded in [issues.md](issues.md):

| Left out | Why | Issue |
| --- | --- | --- |
| A weekly newsletter archive as a source | Each issue has a new address, so it is fetched as "the archive page, then the newest issue". No source kind does that for a web page | [29](issues.md) |
| Pages that only fill in with JavaScript | The web page adapter makes a plain request. Every source in use answers one, so no headless browser is needed today | [31](issues.md) |
