# Claude's answers, checked against the feed

Each of Claude's tool calls, as the server logged it, sent again over REST with the same arguments.

## Call 1: `search_experiences`

- **Arguments Claude sent:** `{"from": "2027-09-20", "limit": 8, "location": "hermanus", "query": "whales, whale watching, wine, wine tasting, luxury for a couple", "to": "2027-09-30"}`
- **Logged as:** request `40e9cded-f923-4a34-92d4-4ab85c6dde53`, from 160.79.106.168, tenant `f84768fb-03c9-4efe-b630-eed7a7ae3526`, user `bbd2aedc-98a3-425b-bb6a-dd5fdf3e76c2`, the agent key `MqGs5z3oN0iuP9fBCAGUbH8kSirTZNhV`, answered 200 in 2151 ms
- **The same call over REST:** 200
- **Total the feed reports:** 43

| # | Title | Tier | Status | Booking | Bookable | Price | Sessions in the stay |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Private whale watching charter with Southern Right Charters | luxury | confirmed | open | yes | R78000 to R78000 | 11 |
| 2 | Boat-based whale watching with Southern Right Charters | premium | confirmed | open | yes | R0 to R1580 | 11 |
| 3 | Hermanus Whale Cruises boat-based whale watching | premium | confirmed | open | yes | R0 to R1500 | 11 |
| 4 | Shark Cage Diving & Surface Viewing | premium | confirmed | open | yes | R2350 to R3850 | 11 |
| 5 | Shark cage diving with Cape Shark Adventures | premium | confirmed | open | yes | R2400 to R2950 | 11 |
| 6 | Panthera Africa Sunset Visits | premium | confirmed | open | yes | R490 to R490 | 1 |
| 7 | Cuvée Weekends | standard | confirmed | open | yes | R295 to R295 | 2 |
| 8 | Family Sharing Lunch | standard | confirmed | open | yes | R325 to R650 | 11 |

Most premium first: holds.

## Call 2: `get_experience_changes`

- **Arguments Claude sent:** `{"from": "2026-12-01", "limit": 100, "location": "hermanus", "since": "2026-11-23T17:10:00Z", "to": "2027-01-31"}`
- **Logged as:** request `667d5362-e450-4619-b435-46b132ac1f14`, from 160.79.106.179, tenant `f84768fb-03c9-4efe-b630-eed7a7ae3526`, user `bbd2aedc-98a3-425b-bb6a-dd5fdf3e76c2`, the agent key `MqGs5z3oN0iuP9fBCAGUbH8kSirTZNhV`, answered 200 in 12 ms
- **The same call over REST:** 200
- **Total the feed reports:** 8

| Title | Kind | Fields changed | Before | Now | Moved out of the stay |
| --- | --- | --- | --- | --- | --- |
| Studio 54 New Years Eve Party | removed | status, booking | `{"status": "confirmed", "booking": "open"}` | `{"status": "removed", "booking": "closed"}` | no |
| Stanford Festive Market | changed | sessions | `{"sessions": ["2026-12-11 10:00", "2026-12-12", "2026-12-13"]}` | `{"sessions": ["2026-12-11 10:00", "2026-12-13"]}` | no |
| Ballyhoo: The 50 Year Celebration | confirmed | status, booking | `{"status": "announced", "booking": "not_yet"}` | `{"status": "confirmed", "booking": "open"}` | no |
| The Latin Guitar with James Grace | changed | price | `{"price": {"min": 200, "max": 200, "currency": "ZAR"}}` | `{"price": {"min": 240, "max": 240, "currency": "ZAR"}}` | no |
| A Tribute to Elton John | changed | booking | `{"booking": "open"}` | `{"booking": "sold_out"}` | no |
| Riaan Benadé Live | rescheduled | sessions | `{"sessions": ["2026-12-14 19:00"]}` | `{"sessions": ["2026-12-21 19:00"]}` | no |
| Crimson House | postponed | status, booking | `{"status": "confirmed", "booking": "open"}` | `{"status": "postponed", "booking": "closed"}` | no |
| Neil Diamond Tribute - Johan Liebenberg | cancelled | status, booking | `{"status": "confirmed", "booking": "open"}` | `{"status": "cancelled", "booking": "closed"}` | no |

The database has 9 change rows after `2026-11-23T17:10:00Z`: Studio 54 New Years Eve Party (removed); ISA Miniature Convention (changed); Stanford Festive Market (changed); Ballyhoo: The 50 Year Celebration (confirmed); The Latin Guitar with James Grace (changed); A Tribute to Elton John (changed); Riaan Benadé Live (rescheduled); Crimson House (postponed); Neil Diamond Tribute - Johan Liebenberg (cancelled).

## Call 3: `get_experience_changes`

- **Arguments Claude sent:** `{"from": "2026-12-14", "limit": 100, "location": "hermanus", "since": "2026-11-23T17:10:00Z", "to": "2026-12-14"}`
- **Logged as:** request `730febdb-f887-46b9-a697-ef5f5b06f013`, from 160.79.106.160, tenant `f84768fb-03c9-4efe-b630-eed7a7ae3526`, user `bbd2aedc-98a3-425b-bb6a-dd5fdf3e76c2`, the agent key `MqGs5z3oN0iuP9fBCAGUbH8kSirTZNhV`, answered 200 in 38 ms
- **The same call over REST:** 200
- **Total the feed reports:** 1

| Title | Kind | Fields changed | Before | Now | Moved out of the stay |
| --- | --- | --- | --- | --- | --- |
| Riaan Benadé Live | rescheduled | sessions | `{"sessions": ["2026-12-14 19:00"]}` | `{"sessions": ["2026-12-21 19:00"]}` | yes |

The database has 9 change rows after `2026-11-23T17:10:00Z`: Studio 54 New Years Eve Party (removed); ISA Miniature Convention (changed); Stanford Festive Market (changed); Ballyhoo: The 50 Year Celebration (confirmed); The Latin Guitar with James Grace (changed); A Tribute to Elton John (changed); Riaan Benadé Live (rescheduled); Crimson House (postponed); Neil Diamond Tribute - Johan Liebenberg (cancelled).

## Call 4: `search_experiences`

- **Arguments Claude sent:** `{"from": "2026-12-10", "location": "franschhoek", "to": "2026-12-20"}`
- **Logged as:** request `c0feacce-dd84-4c6b-afb5-3e0549e512f3`, from 160.79.106.171, tenant `f84768fb-03c9-4efe-b630-eed7a7ae3526`, user `bbd2aedc-98a3-425b-bb6a-dd5fdf3e76c2`, the agent key `MqGs5z3oN0iuP9fBCAGUbH8kSirTZNhV`, answered 200 in 23 ms
- **The same call over REST:** 400
- **The feed's answer:** `invalid_input`: The feed does not cover a place called franschhoek. It covers: hermanus. Give one of them, or a point with near.

## Call 5: `search_experiences`

- **Arguments Claude sent:** `{"attributes": {"tier": ["luxury", "premium"]}, "bookable": true, "from": "2026-12-14", "limit": 100, "location": "hermanus", "to": "2026-12-20"}`
- **Logged as:** request `91061f58-e0ef-4957-a553-b2f54d24231b`, from 160.79.106.179, tenant `f84768fb-03c9-4efe-b630-eed7a7ae3526`, user `bbd2aedc-98a3-425b-bb6a-dd5fdf3e76c2`, the agent key `MqGs5z3oN0iuP9fBCAGUbH8kSirTZNhV`, answered 200 in 22 ms
- **The same call over REST:** 200
- **Total the feed reports:** 7

| # | Title | Tier | Status | Booking | Bookable | Price | Sessions in the stay |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Hermanus Whale Cruises Eco Marine cruise | premium | confirmed | open | yes | R0 to R1200 | 7 |
| 2 | Shark Cage Diving & Surface Viewing | premium | confirmed | open | yes | R2350 to R3850 | 7 |
| 3 | Shark cage diving with Cape Shark Adventures | premium | confirmed | open | yes | R2400 to R2950 | 7 |
| 4 | Dam Fine Wine | premium | confirmed | open | yes | R500 to R500 | 1 |
| 5 | Rooted in Cape Agulhas | premium | confirmed | open | yes | R300 to R500 | 1 |
| 6 | Low-carb cooking with Brian Berkman | premium | confirmed | open | yes | R600 to R600 | 1 |
| 7 | Panthera Africa Sunset Visits | premium | confirmed | open | yes | R490 to R490 | 1 |

Most premium first: holds.
The database, asked separately for the same filters and order, gives 7 titles: the same, in the same order.

