# End-to-end success criteria

What version 1 must do for the people and agents who use it, written as scenarios a tester runs from the outside, through REST, MCP and the command line. Each scenario says what must be true for it to pass, so a run can be ticked off without a judgement call wherever that is possible. The tester records each result in the table at the end. Anyone working on the code reads this to know what done means. The use cases are UC1 to UC4 in [architecture.md](architecture.md), and what version 1 leaves out is in [v1-decisions.md](v1-decisions.md).

2026-11-23 · Meiring

## What success looks like

Version 1 has done its job when:

- A travel planner, or the AI agent working for them, asks what is on in Hermanus while their traveller is there, and gets a correct and useful answer: the right experiences, on the right days, with whether they can be booked, narrowed to what suits that traveller.
- The answer holds for a trip 6 to 18 months away. What is known that far out is there, and what is only announced says so.
- The planner asks again months later and gets only what changed since they last looked: what is new, confirmed, moved, postponed, called off or gone.
- The feed keeps itself up to date from real sources, on its own schedule, with nobody feeding it.
- What it says matches what the sources say, and nothing in it is false, over, out of the area or there twice.

Version 1 covers Hermanus and the towns around it. The brief's examples in Johannesburg are outside it.

## Who uses it

| Who | What they are trying to get done | How | Stands for them in a test |
| --- | --- | --- | --- |
| A travel agent at an agency | Find what is on for a traveller's stay, and check back before booking | REST, or a tool built on it | Agency Planner, `planner@agency.example.com`, tenant Example Travel Agency, key "seed person key" |
| An AI agent acting for that planner | The same, in conversation with the planner | MCP | The same user, key "seed agent key" |
| A travel app | Search on behalf of the app's own users | REST from the app's server, or MCP from its assistant | App Planner, `planner@app.example.com`, tenant Example Travel App, keys "seed person key" and "seed agent key" |
| The system admin | Onboard tenants and their users, issue keys, keep the feed running | REST, MCP and the command line | System Admin, `admin@example.com`, key "seed person key" |

The seed prints each key once, when it issues it (`pnpm db:seed`). Keep them for the run. A second agency is onboarded in E2E-31.

## The end-to-end scenarios

### How to run them

- **Two databases.** The scenarios that only read (E2E-01 to E2E-17, E2E-42 and E2E-43) run against the development database as it was sourced on 23 Nov 2026, and the values they quote come from it. Every scenario that changes data runs against an end-to-end database: an empty database, migrated (`pnpm db:migrate`) and seeded (`pnpm db:seed`), with `DATABASE_URL` pointing at it. Never use the test database, which the automated tests empty.
- **Order on the end-to-end database.** Run E2E-18 to E2E-25 in order, then E2E-26 to E2E-41. E2E-21 records the time T1 that the checking-back scenarios use.
- **The server.** `pnpm --filter @magic-events/api start`, on `http://localhost:4000`. The fetching and processing jobs need `ANTHROPIC_API_KEY`, and embedding needs `AWS_REGION` and AWS credentials.
- **REST.** Search is `POST /v1/experiences/search` and changes are `POST /v1/experiences/changes`, with `Authorization: Bearer <key>` and a JSON body.
- **MCP.** `POST /mcp` with the key in `Authorization`, `Accept: application/json, text/event-stream`, and a JSON-RPC `tools/call` naming `search_experiences` or `get_experience_changes` with the same arguments as the REST body. The answer is in `result.structuredContent`.
- **The command line.** `pipeline` and `captures`, run with `pnpm cli:pipeline <command>` and `pnpm cli:captures` from the root once the command line has moved to `apps/cli`, and with `pnpm pipeline <command>` and `pnpm --filter @magic-events/api captures` before that.
- **Dates.** The dates below are chosen for a run before 5 December 2026. A later run keeps the same shape and moves the dates past today.
- **A scenario passes** only when every condition under "Passes when" holds. "Depends on issue N" means the scenario fails until that issue in [issues.md](issues.md) lands.

Two stays are used throughout:

| Stay | Dates | Body |
| --- | --- | --- |
| Winter stay | Sun 20 to Wed 30 June 2027, seven months ahead | `{ "location": "hermanus", "from": "2027-06-20", "to": "2027-06-30" }` |
| December stay | Mon 7 to Sun 20 December 2026 | `{ "location": "hermanus", "from": "2026-12-07", "to": "2026-12-20" }` |

### Planning a trip (UC1)

#### E2E-01 · What is on while the traveller is there

- **Goal:** "My clients are in Hermanus from 20 to 30 June 2027. What is on?"
- **Who and how:** Agency Planner, person key, REST.
- **Steps:** search with the winter stay.
- **Passes when:**
  - The answer is 200 with `total` 33.
  - Every item's status is expected, announced, confirmed or postponed, and every session it carries overlaps 20 to 30 June 2027.
  - Items come in date order of their first session in the stay.
  - `bookable` is true exactly when status is confirmed and booking is open.
  - "2027 Hermanus FynArts Festival" is there: announced, booking not yet, not bookable, one session 24 June to 4 July 2027 with day precision.
  - "Sculpture on the Cliffs" is there with one session of month precision, June 2026 to June 2027.
  - "Hermanus Country Market" is there with exactly one session, Saturday 26 June, 09:00 to 14:00.
  - Every item has the fields of the search answer, its own page address (`pageUrl`, which may be empty) among them.

#### E2E-02 · Only what suits their interests

- **Goal:** "They love art. Only show me art."
- **Who and how:** Agency Planner, REST.
- **Steps:** the winter stay with `"attributes": { "category": ["visual_arts"] }`. Then the winter stay with `"tags": ["whales"]`.
- **Passes when:**
  - The first answer has exactly the four experiences with visual arts as a category: 2027 Hermanus FynArts Festival, Sculpture on the Cliffs, Hermanus Country Market and Akwaaba Market. Hermanus parkrun is not there.
  - The second answer includes "Hermanus Whale Cruises boat-based whale watching", and every item carries the tag `whales`.

#### E2E-03 · A family with young children

- **Goal:** "A family with a 10-year-old, over Christmas. Nothing for adults only."
- **Who and how:** App Planner, REST.
- **Steps:** search 12 to 31 December 2026 with `"attributes": { "audience": ["family", "all_ages"], "minimum_age": { "max": 10 } }`. Then the same dates with `"attributes": { "minimum_age": { "min": 18 } }`.
- **Passes when:**
  - The first answer includes "Paddakoor Akademie Presents - CHRISTMAS CARNIVAL" (12 December) and "New Years´s Eve Family Day at Landskein" (31 December), and includes experiences with no age limit recorded, such as Hermanus Country Market.
  - No item in it has audience adults or a minimum age above 10. "Electro DANCE - Sunset Beats to Late Night Bass" (18 and over) is not there.
  - The second answer is only experiences with a recorded minimum age of 18 or more: "Electro DANCE - Sunset Beats to Late Night Bass", 16 December.

#### E2E-04 · Only what can be booked now

- **Goal:** "What can I book for them today?"
- **Who and how:** Agency Planner, REST.
- **Steps:** the winter stay with `"bookable": true`.
- **Passes when:**
  - Every item is confirmed, booking open and `bookable` true.
  - The answer is the eight experiences that are: Cape Shark Adventures, Cuvée Weekends at Benguela Cove, Deli Dining at Dal-Italia, Harold Porter National Botanical Garden, Hermanus Whale Cruises boat-based whale watching, Panthera Africa Sunset Visits, Shark Cage Diving & Surface Viewing- Gansbaai and Sourdough Baking Class.
  - The FynArts Festival, whose booking has not opened, is not there.

#### E2E-05 · By the place's name

- **Goal:** "Search Hermanus" without knowing its coordinates.
- **Who and how:** Agency Planner, REST.
- **Steps:** the winter stay as it is. Then with `"location": "cape-agulhas"`. Then with both `location` and `near`. Then with neither.
- **Passes when:**
  - The first answer is E2E-01's.
  - Each of the other three is 400 `invalid_input`: an unknown location with a detail on `location` that names it, both with a detail on `near`, neither with a detail on `location`.

#### E2E-06 · Around a point, within a radius

- **Goal:** "What is on within 25 kilometres of where they are staying?"
- **Who and how:** Agency Planner, REST.
- **Steps:** the winter stay with `"near": { "lat": -34.4187, "lng": 19.2345 }, "radiusKm": 25` in place of `location`. Then with `"radiusKm": 201`.
- **Passes when:**
  - The first answer has the same items, in the same order, as E2E-01, and every item has `distanceKm`.
  - The second is 400 `invalid_input` with a detail on `radiusKm` that gives the limit, 200.
  - An experience whose listing states its venue's coordinates carries them in `venue.position`, and its `distanceKm` is its real distance: an experience in Stanford is about 20 km away and is left out by a radius of 10. Depends on issue 35.
  - An experience whose listing states none has an empty position and is searched from the centre of Hermanus, at distance 0. That is the version 1 limit in [v1-decisions.md](v1-decisions.md) and issue 45.

#### E2E-07 · In the order the traveller would like

- **Goal:** "They like sculpture and quiet galleries. Put that first."
- **Who and how:** Agency Planner, REST.
- **Steps:** the winter stay with `"query": "sculpture and art galleries, quiet and outdoors"`. Then with `"query": "FynArts"`. Then the first again with the embedding model unreachable (the server started with `AWS_REGION` empty).
- **Passes when:**
  - Each answer has the same `total` and the same set of experiences as E2E-01. The query text only reorders.
  - "Sculpture on the Cliffs" is in the first three of the first answer, and "2027 Hermanus FynArts Festival" is first in the second.
  - With the model unreachable the search still answers 200 with the same set, ordered by keyword, within the 5 second wait plus the search itself.

#### E2E-08 · Paging through a long answer

- **Goal:** "Show me ten at a time."
- **Who and how:** Agency Planner, REST.
- **Steps:** the winter stay with `"limit": 10` and `"offset"` 0, 10, 20 and 30.
- **Passes when:** every page has `total` 33; the pages hold 10, 10, 10 and 3 items; no experience is on two pages; together they are E2E-01's items in E2E-01's order.

#### E2E-09 · The same answer for an AI agent over MCP

- **Goal:** the planner's AI agent asks the same question and gets the same answer.
- **Who and how:** Agency Planner, agent key, MCP.
- **Steps:** `tools/list`. Then `tools/call` of `search_experiences` with the bodies of E2E-01, E2E-03 and E2E-07.
- **Passes when:**
  - `tools/list` lists `search_experiences` and `get_experience_changes`, each with a description and an input schema.
  - Each `structuredContent` equals the REST answer for the same body: the same items, in the same order, with the same `total`.

#### E2E-10 · A real AI agent plans the stay

- **Goal:** "A retired couple who love art and nature are in Hermanus from 20 to 30 June 2027. What is on for them?", asked in plain words.
- **Who and how:** an MCP client such as Claude, connected to `/mcp` with the Agency Planner's agent key.
- **Steps:** ask the question as written, with nothing else.
- **Passes when:**
  - The server log shows a `search_experiences` call with `location` `hermanus` (or a point in Hermanus), `from` 2027-06-20 and `to` 2027-06-30, made with the agent key (`callerKind` agent).
  - The reply names the 2027 Hermanus FynArts Festival with its dates, 24 June to 4 July 2027, and says it cannot be booked yet. It names Sculpture on the Cliffs.
  - Every experience the reply names is in the tool's answer, with the dates the answer gives.

### Each kind of experience in the brief

#### E2E-11 · Something to go to on one date

- **Goal:** "Is there a concert on Friday 11 December?"
- **Who and how:** Agency Planner, REST.
- **Steps:** search 11 to 11 December 2026. Then 12 to 12 December 2026.
- **Passes when:**
  - The first answer has "Rumours of Fleetwood Mac Tribute at Hermanus Golf Club 11 Dec 2026" once: confirmed, booking open, bookable, venue Hermanus Golf Club, price 430 ZAR, one session on 11 December from 18:00 to 22:30, and a booking link.
  - The second answer does not have it.

#### E2E-12 · Something that runs, only on its own dates

- **Goal:** "Is it on while they are there?", for something with many dates.
- **Who and how:** Agency Planner, REST.
- **Steps and passes when:**

| Experience | Its dates | Search | Must be |
| --- | --- | --- | --- |
| Swallow Series Wine Tasting Lunches (a run) | Saturdays 5 Dec 2026, 9 Jan, 13 Mar, 17 Apr and 4 Sep 2027 | 6 Dec 2026 to 8 Jan 2027 | Not returned |
| | | 1 Dec 2026 to 10 Jan 2027 | Returned with exactly two sessions, 5 December and 9 January |
| Sourdough Baking Class (every Thursday) | Thursdays, 11:00 to 15:00 | Mon 7 to Wed 9 Dec 2026 | Not returned |
| | | Mon 7 to Thu 10 Dec 2026 | Returned with exactly one session, 10 December |
| Where the Wild Things Come to Rest: Carol Bryant Wildlife Sculpture Exhibition (open for a period) | 3 Oct 2026 to 31 Mar 2027 | 1 to 7 Feb 2027 | Returned with one session, 3 October to 31 March |

The run and the weekly class are never returned for a day between their dates. That is the Thursdays-only rule in UC1.

#### E2E-13 · Something months away, known only by its month

- **Goal:** "Is anything on in mid-August 2027?"
- **Who and how:** Agency Planner, REST.
- **Steps:** search 14 to 15 August 2027. Then 1 to 5 September 2027.
- **Passes when:**
  - The first answer has "Kalfiefees Hermanus Kunstefees 2027": announced, not bookable, one session from 1 to 31 August 2027 with month precision and no times.
  - The second answer does not have it.
  - An experience whose days are announced has day precision: the FynArts Festival in E2E-01.

#### E2E-14 · A recurring market

- **Goal:** "Which markets are on, and on which days?"
- **Who and how:** App Planner, REST.
- **Steps:** search with the December stay. Then Mon 7 to Fri 11 December 2026. Then 1 to 14 February 2027.
- **Passes when:**
  - With the December stay, "Hermanus Country Market" has exactly two sessions, Saturdays 12 and 19 December, each 09:00 to 14:00, and "Hermanus Country Market Summer Night Markets" has exactly two, Wednesdays 9 and 16 December, each 17:00 to 21:00.
  - From Monday to Friday, the Saturday market is not returned.
  - In February, the summer night markets, which are only in December and January, are not returned.

#### E2E-15 · Seasons are tags, never experiences

- **Goal:** "Is it whale season while they are there?"
- **Who and how:** Agency Planner, REST.
- **Steps:** the winter stay with `"tags": ["whale-season"]`. Then look at the tags of the experiences named below in any search that returns them.
- **Passes when:**
  - The answer includes the 2027 Hermanus FynArts Festival.
  - The FynArts Festival carries `whale-season` and `winter`. "Hermanus Whale Cruises boat-based whale watching" (June to November) carries `whale-season` and `whales`. "Christmas Eve Dinner 2026 at Moody Lagoon" carries `summer`, `high-season` and `south-african-school-holidays`, and not `whale-season`.
  - No search returns an experience that is a season. "Southern Right Whales in Walker Bay" must not be an experience. Depends on issue 48.

A season tag is on the experience, not on each session, so an experience carries a season only when all of its dates fall inside it. A market that runs all year carries no season.

### The long planning window

#### E2E-16 · Planning 6 to 18 months ahead

- **Goal:** "The trip is in May 2028. What can we count on?"
- **Who and how:** Agency Planner, REST.
- **Steps:** search 1 to 14 May 2028, 17 months ahead. Then 1 to 30 September 2027.
- **Passes when:**
  - The May 2028 answer has the open-ended recurring experiences with their sessions in those dates: Hermanus Country Market on Saturdays 6 and 13 May 2028.
  - The September 2027 answer has the festivals announced for next year with month precision and status announced: Hermanus Whale Festival, Hermanus Flower and Eco Fair and Hermanus Adventure Week. It has "Swallow Series Wine Tasting Lunches" with its one session on 4 September 2027.
  - No item that far ahead is confirmed with booking open unless its source sells tickets now.

#### E2E-17 · Nothing beyond what is known

- **Goal:** "What about after November 2028?"
- **Who and how:** Agency Planner, REST.
- **Steps:** search a week that starts more than 24 months after today, such as 1 to 14 December 2028 for a run on 23 November 2026.
- **Passes when:** no open-ended recurring experience is returned, because none has sessions past the 24 month horizon yet (`CATALOGUE_SESSION_HORIZON_MONTHS`), and every item returned has a session a source listed inside those dates.

The status Expected exists, but version 1 sets it nowhere: an annual festival known only by its month comes in as Announced.

### The feed keeps itself current (UC3)

#### E2E-18 · The schedule fills an empty feed by itself

- **Goal:** the system admin starts the system and the feed fills from real sources with nobody feeding it.
- **Who and how:** the system admin, the server and its jobs.
- **Steps:** on the end-to-end database, freshly seeded, start the server with `DISCOVERY_SCHEDULE_CRON="* * * * *"`. Wait until the processing and embedding jobs have run.
- **Passes when:**
  - The log says the jobs started, with each schedule.
  - Every active seeded source has a run. Each run succeeded, or failed with a reason recorded.
  - No raw listing is left pending: `pipeline process` prints "Nothing was pending."
  - The winter stay returns the 2027 Hermanus FynArts Festival, from the Hermanus FynArts source.
  - Every experience search can return has an embedding, so a query text can order by meaning: `pipeline embed` prints 0 remain.

#### E2E-19 · A failed fetch is tried again

- **Goal:** a source that is down for a while is fetched once it is back.
- **Who and how:** the system admin, the server and its jobs.
- **Steps:** run with E2E-18. Before the server starts, make one source's host unreachable, for example `127.0.0.1 www.wesgro.co.za` in `/etc/hosts`, and start it with `DISCOVERY_FETCH_RETRY_BACKOFF_MINUTES=1`. After the first failure, make the host reachable again.
- **Passes when:**
  - That source's first run failed with a reason, and the log shows its fetch job failing.
  - It is tried again after one to two minutes and then about every doubled wait, without waiting a week, and the first retry after the host is back succeeds.
  - The failed run removed nothing: no listing of that source was counted as missing.

#### E2E-20 · Scraped sources load through the same pipeline

- **Goal:** the sources a browser scrape read join the feed.
- **Who and how:** the system admin, the command line.
- **Steps:** copy `data/hermanus` to a working folder outside the repository. Run `captures --dir <that folder>`, then `pipeline embed`.
- **Passes when:** every source in its `sources.json` is loaded with no failed run and no failed raw listing, and the summary names how many experiences were saved and how many were new.

#### E2E-21 · An unchanged listing changes nothing

- **Goal:** fetching a source again that has not changed leaves the feed as it was.
- **Who and how:** the system admin, the command line and REST.
- **Steps:** search with the December stay and record the time as T1. Run `captures --dir <that folder>` again. Run `pipeline refetch --source "Wesgro Cape Overberg events"` twice in a row.
- **Passes when:**
  - The second load reports 0 new or changed for every source.
  - The second refetch reports 0 new or changed.
  - No experience has a new version.
  - The Hermanus FynArts page is the one known exception: its fingerprint changes between fetches. Its experiences must still get no new version. Depends on issue 49 for the page itself.

#### E2E-22 · A changed listing updates its experience

- **Goal:** a change at the source reaches the experience.
- **Who and how:** the system admin, the command line.
- **Steps:** in the copied folder, change each captured page and its entry in `extracted/<source>.json` together, as below, so the page's content and what was read from it agree. Run `captures --dir <that folder> --source benguela-cove` and `captures --dir <that folder> --source race2hermanus`.

| Experience | Page (`raw/`) | Change | Change it must make |
| --- | --- | --- | --- |
| Dancing Queen: The Ultimate ABBA Experience | `benguela-cove/dancing-queen-ultimate-abba-experience.txt` | Called off by the organisers: status cancelled, booking closed | Cancelled |
| Andrew Young Live Concert | `benguela-cove/andrew-young-live-concert.txt` | Postponed with no new date: status postponed, booking closed | Postponed |
| That ’80s Show: 80s Tribute Concert | `benguela-cove/that-80s-show-concert.txt` | The 27 February 2027 show moves to 6 March 2027 | Rescheduled |
| Christmas Eve Dinner 2026 at Moody Lagoon | `benguela-cove/christmas-eve-dinner-2026.txt` | A price of R650 a person | Changed |
| Race2Hermanus Triathlon 2027 | `race2hermanus/home.txt` | Entries open: status confirmed, booking open, a booking link | Confirmed |

- **Passes when:**
  - Each load reports the edited pages as changed and every other page unchanged.
  - Each of the five experiences has one new version, and its own page or search shows the new values. Each keeps its ID.
  - No new experience was created.

#### E2E-23 · A listing that disappears leads to Removed

- **Goal:** something no source lists any more is taken out of the feed.
- **Who and how:** the system admin, the command line and REST.
- **Steps:** delete `raw/benguela-cove/swallow-series-wine-tasting-lunch-events.txt` from the copied folder. Run `captures --dir <that folder> --source benguela-cove` three times. Search 1 December 2026 to 30 September 2027 after the second load and after the third.
- **Passes when:**
  - After the second load "Swallow Series Wine Tasting Lunches" is still returned.
  - After the third load, three complete runs without its page, it is not returned. Its status is removed, not cancelled.

#### E2E-24 · One experience across many sources

- **Goal:** the same concert listed on six sites is one experience.
- **Who and how:** Agency Planner, REST.
- **Steps:** search 11 to 11 December 2026 with `"query": "Fleetwood Mac"`. Search 28 to 28 November 2026 with `"query": "Rosoberry"`.
- **Passes when:** "Rumours of Fleetwood Mac Tribute at Hermanus Golf Club 11 Dec 2026" (Quicket, AllEvents.in, Facebook and The Village NEWS, six sources) is returned once, and "Rosoberry Harvest Fest 2026" (eight sources) is returned once.

#### E2E-25 · The operator fetches again and processes again

- **Goal:** the system admin refreshes a source or a place now, or runs listings through processing again after a fix.
- **Who and how:** the system admin, the command line.
- **Steps:**
  - `pipeline refetch --location hermanus`, `pipeline refetch --source "Hermanus FynArts"`, and `pipeline refetch --listing <ID>` with a listing's ID read from the database.
  - `pipeline reprocess --experience <slug> --now` with the FynArts Festival's slug as search returns it. `pipeline reprocess --source "Quicket public pages"`, then `pipeline process`.
  - `pipeline reprocess` with no selector.
- **Passes when:**
  - Each refetch prints a line per source fetched, with its counts. The listing's refetch says which source it belongs to and fetches that source whole.
  - The experience reprocess prints how many listings it sent back and processes them. The FynArts Festival keeps its ID, and no second FynArts Festival appears. Its version goes up only if a field really changed.
  - The source reprocess sends every listing of that source back, and processing them creates no duplicate.
  - With no selector the command prints that it needs exactly one of `--listing`, `--experience`, `--source` and `--location`, and exits with an error.

### Checking back later (UC2)

#### E2E-26 · Nothing changed, nothing reported

- **Goal:** "Has anything changed since I last looked?", when nothing has.
- **Who and how:** Agency Planner, REST.
- **Steps:** after E2E-21, ask for changes with the December stay and `"since"` T1.
- **Passes when:** the answer is 200 with no items and `total` 0.

#### E2E-27 · What changed is reported, with what kind of change

- **Goal:** months later, the planner gets only what changed.
- **Who and how:** Agency Planner, REST.
- **Steps:** after E2E-22, ask for changes with `"location": "hermanus", "from": "2026-12-01", "to": "2027-05-31"` and `"since"` T1.
- **Passes when:**
  - The items are exactly the five experiences of E2E-22, and no other.
  - Each `change.kind` is the one in E2E-22's table: cancelled, postponed, rescheduled, changed and confirmed.
  - Each item's `changes` lists every change since T1, newest first, and the items come most recent change first.
  - The postponed concert is still returned by search for 9 January 2027 as postponed, booking closed and not bookable. The confirmed triathlon is bookable.
  - Asked for changes since a time before E2E-20's load, with the December stay, the experiences that load created are reported as new.

#### E2E-28 · Cancelled and removed are reported though search drops them

- **Goal:** "Tell me if something I planned around is off."
- **Who and how:** Agency Planner, REST.
- **Steps:** search 30 January 2027. Ask for changes since T1 with 1 December 2026 to 30 September 2027. Ask again with `"bookable": true` and with `"status": ["confirmed"]`.
- **Passes when:**
  - Search does not return "Dancing Queen: The Ultimate ABBA Experience".
  - Each changes answer reports it as cancelled, with status cancelled, and reports "Swallow Series Wine Tasting Lunches" as removed, with status removed, whatever `bookable` and `status` say.
  - No experience that is over is reported.

#### E2E-29 · Moved out of the dates searched

- **Goal:** "The show we booked around has moved. Tell me."
- **Who and how:** Agency Planner, REST.
- **Steps:** ask for changes since T1 with 20 to 28 February 2027, the dates the planner searched before the show moved. Then with 1 to 10 March 2027.
- **Passes when:**
  - Both answers report "That ’80s Show: 80s Tribute Concert" as rescheduled.
  - The first holds only once changed-since matches on the sessions an experience had before the change. Depends on issue 47.

#### E2E-30 · Checking back through MCP

- **Goal:** the AI agent asks what changed and gets the planner's answer.
- **Who and how:** Agency Planner, agent key, MCP.
- **Steps:** `get_experience_changes` with E2E-27's arguments. Then with `"since"` an hour from now.
- **Passes when:** the first `structuredContent` equals E2E-27's REST answer, and the second is a tool error `invalid_input` whose details name `since`.

### Onboarding (UC4)

#### E2E-31 · Onboard a travel agency over REST

- **Goal:** the system admin sets up a new agency, and its planner can start at once.
- **Who and how:** System Admin, REST.
- **Steps:**
  - `POST /v1/tenants` with `{ "name": "Second Example Agency", "slug": "second-example-agency", "kind": "travel_agency" }`.
  - `POST /v1/tenants/second-example-agency/users` with `{ "name": "Second Planner", "email": "planner@second-agency.example.com" }`.
  - `POST /v1/users/<user ID>/credentials` with `{ "name": "planning desk", "kind": "person" }`, then with `{ "name": "trip assistant", "kind": "agent" }`.
  - With no wait, search with the winter stay using the person key over REST, and using the agent key over MCP.
  - `GET /v1/users/<user ID>/credentials` and `GET /v1/tenants/second-example-agency`.
  - Create the tenant again, and add the user again.
- **Passes when:**
  - The tenant is 201, active, a travel agency. The user is 201 with role client and the tenant's ID. Each key is 201 and shown in that answer only.
  - Both searches are 200 with E2E-01's answer.
  - The list shows both keys, enabled, named, with who uses them, and no key. The tenant shows its one user.
  - Creating it again is 409 `conflict` with a detail on `slug`, and adding the user again is 409 `conflict` with a detail on `email`.

#### E2E-32 · Onboard a travel app over MCP

- **Goal:** the same onboarding, done by the admin's own AI agent.
- **Who and how:** System Admin, MCP.
- **Steps:** `create_tenant` with `{ "name": "MCP Example App", "slug": "mcp-example-app", "kind": "travel_app" }`, `add_tenant_user`, `issue_credential` with kind agent, `list_tenants`, `get_tenant`.
- **Passes when:** each call answers as its REST twin in E2E-31 does, and the issued key searches over MCP straight away.

#### E2E-33 · A suspended tenant is refused

- **Goal:** the system admin turns an agency's access off, and on again.
- **Who and how:** System Admin and Second Planner, REST and MCP.
- **Steps:** `PATCH /v1/tenants/second-example-agency` with `{ "status": "suspended" }`. Search with both of Second Planner's keys. Set it back to active and search again.
- **Passes when:** while suspended both keys get 403 `forbidden`, over REST and MCP alike. Once active both get 200 again.

#### E2E-34 · A revoked key is refused

- **Goal:** a key that leaked is switched off without stopping the planner's other key.
- **Who and how:** System Admin and Second Planner, REST.
- **Steps:** `DELETE /v1/users/<user ID>/credentials/<person key ID>`. Search with that key and with the agent key. List the user's keys.
- **Passes when:**
  - The revoke answers 200 with the key disabled.
  - That key gets 401 `unauthenticated` with a `WWW-Authenticate` header, from then on. The agent key still gets 200.
  - The list shows the revoked key as disabled.

### Several tenants at once

#### E2E-35 · Every tenant sees the same feed

- **Goal:** two agencies and a travel app, people and agents, all plan at the same time.
- **Who and how:** Agency Planner, App Planner and Second Planner, every key each has, REST and MCP.
- **Steps:** send the winter stay search with every key at the same time, several times over.
- **Passes when:** every answer is 200 and the same: the same items in the same order with the same `total`. No answer holds anything about a tenant or a user.

#### E2E-36 · A client cannot reach tenants, users or keys

- **Goal:** one tenant never sees or changes another's people or keys.
- **Who and how:** Agency Planner, REST and MCP.
- **Steps:** with the Agency Planner's key: `GET /v1/tenants`, `GET /v1/tenants/example-travel-app`, `POST /v1/tenants`, `PATCH /v1/tenants/example-travel-app`, `GET /v1/users/<App Planner's ID>/credentials`, `DELETE` one of the App Planner's keys. Over MCP, `list_tenants` and `issue_credential`.
- **Passes when:** every REST call is 403 `forbidden`, every MCP call is a tool error `forbidden`, and nothing changed: the App Planner's keys still work.

### Trust and safety of the interface

#### E2E-37 · No call without a valid key

- **Goal:** only callers with a working key get anything.
- **Who and how:** anyone, REST and MCP.
- **Steps:** search with no key, with `Authorization: Bearer nonsense`, and with a malformed header. `POST /mcp` with no key. `GET /v1/nothing-here` with no key and with a key. `GET /health` with no key. `GET /openapi.json` with no key and with a key.
- **Passes when:**
  - Every call without a valid key is 401 `unauthenticated` with `WWW-Authenticate`, the unknown address included, so a caller without a key cannot tell which addresses exist.
  - The unknown address with a key is 404 `not_found`.
  - `/health` with no key is 200 `{ "status": "ok" }`. `/openapi.json` is 401 without a key and 200 with one.

#### E2E-38 · Wrong input gets a message that names the field

- **Goal:** a planner or an agent that sends something wrong learns what to fix.
- **Who and how:** Agency Planner, REST, and the agent key over MCP for the same bodies.
- **Steps:** the winter stay with, one at a time:

| Change | The detail must name | And say |
| --- | --- | --- |
| `"from": "2027-13-01"` | `from` | It is not a date |
| `"to": "2027-06-01"` | `to` | It is before `from` |
| An extra field `"date": "2027-06-20"` | `date` | It is not a field the search takes |
| `"attributes": { "colour": "red" }` | `attributes.colour` | It is not an attribute, and which attributes can be used |
| `"attributes": { "category": ["opera"] }` | `attributes.category` | It is not an option, and which options there are |
| `"attributes": { "minimum_age": "ten" }` | `attributes.minimum_age` | It is the wrong type |
| `"attributes": { "minimum_age": {} }` | `attributes.minimum_age` | It needs a min or a max |
| `"limit": 500` | `limit` | The largest allowed |
| A body that is not JSON | | The body is not valid JSON |

- **Passes when:**
  - Each REST answer is 400 `invalid_input` in the one error format (`code`, `message`, `details` with `path` and `message`, `requestId`), with the detail above. Each MCP answer is a tool error that names the same field.
  - Each detail's message is a plain sentence that says what to give instead, with an example where there is a form to follow, such as a date like 2027-06-20. No message holds a library's wording, such as `Invalid input`, `expected number` or `Too big`.
  - A planner told the REST `message` alone would know what to change.

#### E2E-39 · No system detail reaches a caller

- **Goal:** when something breaks, the caller is told plainly and learns nothing about the system's insides.
- **Who and how:** Agency Planner, REST and MCP, and anyone calling `/health`.
- **Steps:** stop the database (`docker compose stop postgres`). Search over REST and MCP, and call `/health`. Start it again (`docker compose start postgres`) and repeat, without restarting the server.
- **Passes when:**
  - While the database is down each answer is 503 `unavailable` with `Retry-After`, `/health` included. None is 401 or 500.
  - Once it is back each answer is 200.
  - No answer in any scenario holds a stack trace, SQL, a table or column name, a file path, a library's name or error code, or a provider's error. A failure on our side gives only the general message and the request ID.

#### E2E-40 · Rate limits stop a runaway client

- **Goal:** a client in a loop cannot take the service down for everyone.
- **Who and how:** Agency Planner, REST.
- **Steps:** restart the server with `API_RATE_LIMIT_MAX=5` and send six requests from one address within a minute. Restart it with `API_KEY_RATE_LIMIT_MAX=5` and the address limit at its default, issue a new key, and send six searches with it within a minute, then one with another key.
- **Passes when:**
  - The sixth request from the address is 429 `rate_limited` with `Retry-After`.
  - The sixth with the new key is 429 `rate_limited` with `Retry-After`, and the other key still gets 200.
  - With the defaults, 10000 a minute for each, no scenario in this document is ever limited.

A key's limit is set when the key is issued (issue 26), which is why the test issues a new one.

#### E2E-41 · Every request is traced to who made it

- **Goal:** the system admin can tell who made any request.
- **Who and how:** the system admin, the server log.
- **Steps:** take the `x-request-id` of an answer from E2E-01, from E2E-09, from a refused call in E2E-36 and from a failed one in E2E-39. Find it in the log.
- **Passes when:**
  - Every answer has an `x-request-id` header, and an error body's `requestId` is the same.
  - The log line that closes each request carries the request ID, the tenant, the user, whether a person or an agent called, the key's ID, the status and the time it took. A refused call is logged with its reason, and a failure on our side in full.
  - No key appears anywhere in the log.

### Quality of the answers

This is what the owner cares about most.

#### E2E-42 · A sample of answers matches the sources

- **Goal:** what the planner is told is what the source says.
- **Who and how:** the tester, REST against the development database, and the sources.
- **Steps:**
  - **Choose the sample.** 20 experiences returned by a search of today to 24 months ahead with a radius of 60 km. Draw them at random within these groups, and draw again until every group is covered: at least 3 recurring, 3 runs, 3 on one day, 2 over several days in a row, 2 with month precision, 5 with three sources or more, 5 bookable, 3 from Quicket, 2 from the Whale Coast PDF calendars, and 2 from a page in Afrikaans. Add the named examples of E2E-11 to E2E-14.
  - **Check each one** against its captured page under `data/hermanus/raw/` (the page each listing came from, named in `extracted/<source>.json`), and against the live page where the capture is older than the source's latest version, or where the experience came from a seeded source with no capture.
- **What counts as a match:**

| Field | Matches when |
| --- | --- |
| Title | It names the same experience as the source, so a planner would recognise it. It may drop a date or promotional words |
| Dates and times | Every session is on a day the source says it is on, and no day the source says it is on inside the next 24 months is missing. A run has one session per listed date, a recurring experience follows the source's pattern, and month precision is used only where the source gives only a month. Times are the source's local times |
| Venue | The venue and town are the source's |
| Status and booking | They follow the table under Status and booking from a listing in [data-processing.md](data-processing.md). `bookable` is true only where tickets are on sale now, and the booking link opens a page where they can be bought |
| Price | The source's price or range, in rand |
| Categories, format, audience and tags | Each applies under its description in [data-processing.md](data-processing.md). Minimum age and wheelchair access appear only where a source states them |
| Page address | Where it is given, it opens a page about this experience alone |

- **Passes when:** title, dates and times, status and booking match on all 20. Venue, price, and categories with tags each match on at least 18 of the 20. Every mismatch is recorded with the experience, the field, what the feed says and what the source says.

#### E2E-43 · Nothing false in the feed

- **Goal:** a planner never sends a traveller to something that is not there.
- **Who and how:** the tester, REST against the development database.
- **Steps:** page through a search of today to 24 months ahead with a radius of 60 km, 100 at a time, and check every item.
- **Passes when:**

| Check | Holds when | Seen on 23 Nov 2026 |
| --- | --- | --- |
| Nothing already over | Every item has a session today or later | Holds |
| Nothing outside the area | Every venue is in Hermanus or the towns around it listed under Coverage in [sources.md](sources.md), or in a neighbouring town such as Bot River or Franskraal. None is in Cape Town, Sandton or further | Holds |
| No experience twice | No two items are the same experience. Two dates of one experience are one item | Fails: "Hermanus Whale Festival" is two items, September 2027 from Xplorio and October 2027 from SA-Venues |
| No season as an experience | No title names a season or a natural spectacle alone | Fails: "Southern Right Whales in Walker Bay". Issue 48 |
| Titles a planner would recognise | Every title names an experience | Fails: "Time" and "Hermanus 2026". Issue 48 |
| Festivals are one experience | No item is one item of a festival's programme on the festival's own dates | Holds |
| Bookable means it can be booked | Every bookable item has a booking link or its own page address where it can be booked | Fails: 17 bookable items have neither, such as "Sourdough Baking Class" |
| One session per date for Quicket | No experience from Quicket covers days its page does not list | To check against each page: "Sip & Solve: Blind Wine & Whisky Tasting" is one session from 19 to 30 December 2026. Issue 36 |

## The checks around the scenarios

These hold before the scenarios are run and again after any fix made during the run.

| ID | Check | Passes when |
| --- | --- | --- |
| C-01 | A clean install | `pnpm install --frozen-lockfile` in a fresh checkout succeeds |
| C-02 | The workspace type checks, lints and builds | `pnpm typecheck`, `pnpm lint` and `pnpm build` from the root each exit with no error |
| C-03 | Every automated test passes | `pnpm db:migrate:test`, then `pnpm test` from the root, with no test failed or skipped |
| C-04 | The migrations apply to an empty database | `pnpm db:migrate` against a new, empty database applies every migration with no error, and running it again applies nothing |
| C-05 | The seed runs twice without changing anything | The first `pnpm db:seed` prints the counts and the new keys. The second prints the same counts and "No new API keys", and no row is added or changed |
| C-06 | The server starts and stops cleanly | It logs that it is listening and that the jobs started, `/health` is 200, and on SIGTERM it logs "Stopping" then "Stopped" and exits with code 0, finishing the request or job in hand |
| C-07 | The background jobs run | Within an hour of starting, `pgboss.job` shows a completed job for each of `discovery.find-due-sources`, `processing.process-pending`, `catalogue.embed-experiences` and `catalogue.keep-up`, and no job given up |
| C-08 | Upkeep keeps the feed current | After the upkeep has run, no experience that search can return has its last session before today, and open-ended recurring experiences have sessions up to 24 months from today |

## Results

| ID | Result (pass or fail) | Date | What was seen |
| --- | --- | --- | --- |
| C-01 | | | |
| C-02 | | | |
| C-03 | | | |
| C-04 | | | |
| C-05 | | | |
| C-06 | | | |
| C-07 | | | |
| C-08 | | | |
| E2E-01 | | | |
| E2E-02 | | | |
| E2E-03 | | | |
| E2E-04 | | | |
| E2E-05 | | | |
| E2E-06 | | | |
| E2E-07 | | | |
| E2E-08 | | | |
| E2E-09 | | | |
| E2E-10 | | | |
| E2E-11 | | | |
| E2E-12 | | | |
| E2E-13 | | | |
| E2E-14 | | | |
| E2E-15 | | | |
| E2E-16 | | | |
| E2E-17 | | | |
| E2E-18 | | | |
| E2E-19 | | | |
| E2E-20 | | | |
| E2E-21 | | | |
| E2E-22 | | | |
| E2E-23 | | | |
| E2E-24 | | | |
| E2E-25 | | | |
| E2E-26 | | | |
| E2E-27 | | | |
| E2E-28 | | | |
| E2E-29 | | | |
| E2E-30 | | | |
| E2E-31 | | | |
| E2E-32 | | | |
| E2E-33 | | | |
| E2E-34 | | | |
| E2E-35 | | | |
| E2E-36 | | | |
| E2E-37 | | | |
| E2E-38 | | | |
| E2E-39 | | | |
| E2E-40 | | | |
| E2E-41 | | | |
| E2E-42 | | | |
| E2E-43 | | | |
