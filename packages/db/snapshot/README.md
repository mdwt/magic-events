# The snapshot

`hermanus.sql.gz` is the development database as it stood on 23 November 2026: a full feed for Hermanus and the towns near it. `pnpm quickstart` at the repository root restores it, so a new checkout has something to search with no page to fetch and no model to call. How it is saved and restored is in the [db package's README](../README.md#the-snapshot).

This page says what is in it, how it was built, and what in it was changed by hand. Read the last part before you show the feed to anyone: nine experiences carry changes that are not true of the real events.

## What is in it

| | Count |
| --- | --- |
| Experiences | 283, every one with an embedding and a tier |
| By status | Confirmed 247, expected 25, announced 8, postponed 1, cancelled 1, removed 1 |
| By tier | Luxury 1, premium 23, standard 175, everyday 84 |
| Sources | 50, of which 43 are active |
| Listings and stored pages | 375 listings, 385 stored pages, all processed |
| Migrations recorded | 8, `0000` to `0007` |

Organisations, users and API keys are not in it. `pnpm db:seed` creates them and prints the keys.

A search with a query text needs AWS credentials for the query's own embedding. Without them it orders by keyword only.

## How it was built

The catalogue was built from empty on 23 November 2026, through the pipeline, in this order:

1. `pnpm db:migrate`, then `pnpm db:seed`.
2. `pnpm cli:captures`: the captured pages in `data/hermanus`, with the language model deciding the uncertain matches. 357 captured experiences became 227 experiences.
3. A real fetch of the ten live sources (`pnpm cli:pipeline discover --source "<name>"`), then `pnpm cli:pipeline process` with the real language model, then `pnpm cli:pipeline embed`.

The captured pages go first on purpose. On a tie in priority the listing linked first leads, and a site's own event page is a better source than its listing page.

## What was done by hand

Each of these is a correction to how the data was stored, not a change to an event. None wrote a new version or a change row.

- **Two calendars came from the morning's fetch.** `whalecoast.info` refused connections during the build. Both Whale Coast calendar PDFs had been fetched at 14:07 UTC the same day, so they were put in as that fetch: one run, one listing and one stored page each. The language model then processed them as it would any fetch.
- **Four duplicates were merged.** A live listing page or a calendar row named an event differently from its own page, and the model did not match them: "Ladies Night: Focker In-Law" into "Focker In-Law Premiere Night", "Solstice Secret Sunrise" into "Solstice Secret Sunset", "Secret Sunrise" on 28 November into "Summer Opener Secret Sunrise", and "Hemel-en-Aarde parkrun" into "Hermanus parkrun".
- **Three titles were corrected.** "Harold Porter parkrun" is "Betty's Bay parkrun", "Sixth Cricket" is "Buildit Gansbaai Cricket Day", and "Retreat Yourself 2027" is "Retreat Yourself": the year of an edition is not part of a title.

## Nine changes made for demonstration

A feed built in one day has nothing to report when a planner asks what changed. So nine experiences were changed after the build, one for each kind of change, to show use case 2: checking back on a trip.

**These changes are not true of the real events.** The last column says what each source really says.

Each was made the way a real change arrives: a copy of the captured page was edited and loaded with `pnpm cli:captures --dir <copy> --source <slug>`, so Discovery saw a changed page, Data processing processed it and Catalogue wrote the version, the change and the domain event.

| Experience | What it shows | In the snapshot | What its source really says |
| --- | --- | --- | --- |
| Neil Diamond Tribute - Johan Liebenberg | Cancelled | Cancelled, booking closed, 11 December 2026 | Confirmed and on sale |
| Crimson House | Postponed | Postponed, booking closed, its 18 December date kept | Confirmed and on sale |
| Riaan Benadé Live | Rescheduled | Moved from 14 to 21 December 2026 | 14 December 2026 |
| A Tribute to Elton John | Sold out | Confirmed, sold out, 4 January 2027 | On sale |
| The Latin Guitar with James Grace | A price change | R240, 9 January 2027 | R200 |
| Ballyhoo: The 50 Year Celebration | Confirmed | Confirmed, booking open, 30 December 2026 | Announced, "Tickets open soon!" |
| Stanford Festive Market | One date cancelled | 11 and 13 December on, 12 December cancelled | On all three days |
| Studio 54 New Years Eve Party | Removed | Removed: its page left the source for three runs | Confirmed and on sale, 31 December 2026 |
| ISA Miniature Convention | An on-sale date | Registration opens 1 March 2027, 6 to 10 September 2027 | Announced, no on-sale date |

All nine were made between 17:20 and 17:23 UTC on 23 November 2026, after the build's last change at 17:07. So this call returns exactly these nine:

```json
{ "location": "hermanus", "from": "2026-12-01", "to": "2027-09-30", "since": "2026-11-23T17:10:00Z" }
```

A stay of 1 December 2026 to 31 January 2027 returns eight of them. The ISA Miniature Convention is in September 2027.

To see `movedOut`, ask for changes with a stay of 14 December 2026 only: Riaan Benadé Live comes back as rescheduled with `movedOut: true`, and its session is on 21 December.

## Saving a new one

1. Back up first. `pnpm db:snapshot` is itself the backup of everything but organisations, users, keys and the job queue: copy the old file aside before you overwrite it.
2. Stop the API, so no job writes while the database is read.
3. Check that nothing is waiting: no pending stored page, and no experience without an embedding.
4. `pnpm db:snapshot`, then update the counts on this page and commit both files.

The edited copies of the captures behind the nine changes are not in the repository. To make them again, edit a copy of `data/hermanus` as the table says and load each source from the copy.
