# Sources

Source of truth for which sources the system holds for Hermanus, where each one is, how it gets its listings and what the scrape of 23 Nov 2026 got from it. The source kinds, the fetch port and the fetch flow are in [discovery.md](discovery.md). Which sites answer a plain fetch, checked one by one, is in [hermanus-sources.md](hermanus-sources.md). How a listing becomes an experience is in [data-processing.md](data-processing.md).

2026-11-23 · Meiring

## Coverage

| | |
| --- | --- |
| Location | Hermanus, with the surrounding Overstrand: Onrus, Vermont, Sandbaai, Hawston, Fisherhaven, Voëlklip, Hemel-en-Aarde, Stanford, Kleinmond, Betty's Bay, Pringle Bay, Gansbaai, De Kelders |
| Window | Experiences on from the scrape date to 24 months ahead |
| In the database on 23 Nov 2026 | 50 sources, 43 of them active. 379 listings. 243 experiences, every one linked to at least one listing, 111 of them to two or more |

## How a source gets in

A source row comes from one of two places.

| | Seeded sources | Scraped sources |
| --- | --- | --- |
| Defined in | `apps/cli/src/seed/data/sources.ts` | `data/hermanus/sources.json` |
| Saved by | `pnpm db:seed` | `pnpm cli:captures` |
| Listings come from | The pipeline's own fetch of a listing page, feed or PDF | Pages a browser scrape captured, one listing per page |
| Experiences come from | The language model's extraction | The experiences the scrape read from each page |
| Fetched again | By the schedule, weekly | By the schedule, weekly, when the source is active. An inactive source is refreshed by a new scrape and load |

A site can have both: a seeded row that fetches its listing page, and a scraped row with the event pages behind it, such as "Quicket public pages" and "Quicket event pages". Both link to the same experiences.

## The browser scrape

Pages are read with the agent-browser CLI, a headless Chrome driven the way a person browses the site. Facebook is read in a logged-in Chrome, read only.

- **Finding listings:** the site's own search, its town filter, its events calendar, and pagination to the end. Each town in the coverage is searched, not only Hermanus.
- **Reading a listing:** the listing's own page is opened and the fields are taken from it. A search-result card is never the source of a field.
- **Raw captures:** `data/hermanus/raw/<source>/`, one file per page. Its first line is `URL: <address>`, its second the fetch time, then the page's visible text.
- **Extracted experiences:** `data/hermanus/extracted/<source>.json`, one object per experience, in the extracted experience shape from [data-processing.md](data-processing.md) with its attributes, tags and profile, and the raw file it came from.
- **Blocked sites:** a site that turns the browser away is tried once more with a visible window, then recorded as blocked.

Each captured experience carries a tier among its attributes. The tiers were decided on 23 Nov 2026 by reading the experiences one by one, their title, description, price, venue and format, against the tier attribute's option descriptions, taking the lower tier where two fitted, and judged again the same day after the data audit, so that a tribute show, a DJ party or a lawn concert at gig prices is standard wherever it is held. Of the 442 in the capture files: 1 luxury, 27 premium, 254 standard and 160 everyday. Of the 357 the loader loads, which leaves out the sources and files the manifest skips: 1 luxury, 25 premium, 219 standard and 112 everyday.

### Loading the captures

`pnpm cli:captures` loads every source in `data/hermanus/sources.json`. `pnpm cli:captures --source <slug>` loads one.

For each source it saves the source row, runs it through Discovery with the captured pages standing in for the fetch adapter, and processes the raw listings through Data processing with the captured experiences standing in for the language model's extraction and classification. Runs, listings, fingerprints, the checks on what was extracted, seasons, matching, precedence and saving are the pipeline's own.

- **Matching across sources:** an experience with the same title and overlapping dates is matched in code, as always. Where the titles differ, a plain rule matches the clear cases and the language model is asked about the unsure ones. On 23 Nov 2026 that was 58 plain matches and 41 questions to the model.
- **Running it again** saves nothing new for a page whose capture has not changed.
- **A source is active** when a plain fetch of its pages returns their content, so the schedule can fetch it again. A site that needs a browser or a login is saved inactive.
- **The first scheduled fetch after a load reads every page again.** A capture is a page's visible text as a browser read it, and its fingerprint is not the fingerprint of the page as the adapter fetches it. So the first time the schedule fetches an active captured source, every one of its pages looks changed and goes through the language model once, about 250 pages across the sources. From then on a page is processed only when it changes. Nothing smaller is right: taking the first fetched page as unchanged would hide a real change made since the capture.
- **An inactive source is never checked again by the schedule.** Its experiences stay as they were captured until a new scrape and load, or until their dates pass and they become Past. On 23 Nov 2026 that is 28 experiences known only from inactive sources, Facebook events and Benguela Cove. See [v1-decisions.md](v1-decisions.md).
- **Own pages:** an entry in `sources.json` can say `"ownPages": true` when its pages are an organiser's, operator's or venue's own pages about its own offerings, such as the whale operators, the estates, the market, and a festival's or a race's own site. The loader passes it into the source's settings, so each page is the page address of every experience on it. Listing sites, tourism offices, papers, calendar feeds and files leave it out.
- **Map positions:** the coordinates the scrape read from a page (AllEvents.in's structured data, the map links on Quicket's and Webtickets' event pages, a few others) are passed on as the venue's position, and the extractor's checks apply to them as to the model's: a position that is not a real one, or is more than 100 km from the location, is dropped.

## Seeded sources

Fetched by the pipeline. The check behind each address is in [hermanus-sources.md](hermanus-sources.md).

| Source | Kind | Address | Active | Listings | Experiences |
| --- | --- | --- | --- | --- | --- |
| Hermanus FynArts | Web page | hermanusfynarts.co.za/event-list | Yes | 5 | 3 |
| Hermanus Whale Festival | Web page | hermanuswhalefestival.co.za/wp-json/tribe/events/v1/events | Yes | 1 | 0 |
| Quicket public pages | Web page | quicket.co.za/events/south-africa, searches for hermanus and stanford | Yes | 3 | 29 |
| Overstrand weekly diary | Web page | overstrand.gov.za/top-things-to-do-this-weekend/ | Yes | 1 | 1 |
| Whale Coast annual events calendar | PDF calendar | whalecoast.info/events-calendar/ | Yes | 1 | 11 |
| Whale Coast monthly events calendar | PDF calendar | whalecoast.info/events-calendar/ | Yes | 1 | 24 |
| Wesgro Cape Overberg events | Web page | wesgro.co.za/travel/events, Cape Overberg category | Yes | 1 | 5 |
| Hermanus Times | RSS feed | novanews.co.za/hermanustimes/feed/ | Yes | 10 | 0 |
| AllEvents.in Hermanus | Web page | allevents.in/hermanus/all | Yes | 1 | 37 |
| Xplorio Hermanus | Web page | xplorio.com/hermanus/en/things-to-do/events/ | Yes | 1 | 10 |
| Quicket | Quicket API | Needs `QUICKET_API_KEY`. No adapter yet | No | 0 | 0 |
| Ticketmaster | Ticketmaster API | Needs `TICKETMASTER_API_KEY`. No adapter yet | No | 0 | 0 |

"Hermanus FynArts" holds four listings that are not in its settings. A test load on 23 Nov 2026 saved the scraped FynArts pages under it before they were given a row of their own. The schedule will count them as gone after three complete runs, and the experiences keep their links through "Hermanus FynArts pages".

## Scraped sources

All are web page sources. Priority follows the seed: 30 for the organiser's own site, 20 for a ticket seller, 15 for the municipality's and the tourism offices' pages, 10 for a regional listing or the local paper, 5 for an aggregator.

### Ticket sellers

| Source | Address | Active | Listings | Experiences | Notes |
| --- | --- | --- | --- | --- | --- |
| Quicket event pages | quicket.co.za/events/`<id>`-`<slug>`/ | Yes | 63 | 63 | Found through the Algolia search behind quicket.co.za/events: a search within 70 km of Hermanus and text searches per town and venue. The `?q=` address parameter does not filter the list. Dates run from 23 Nov 2026 to 12 Mar 2027 |
| Webtickets event pages | webtickets.co.za/v2/event.aspx?itemid=`<id>` | Yes | 16 | 16 | The site's search only matches titles, so the Western Cape list of 342 events was read and each venue checked. Includes Harold Porter garden entry and two Gansbaai shark trips as daily recurrences |
| Computicket | computicket.com/event/list?keyword=Hermanus | No | 0 | 0 | Searched for 18 town and region names. Nothing in the Overstrand. The search needs a browser |

Ticketmaster South Africa (ticketmaster.co.za) turned the scrape browser away with a bot check, headed too, so it has no scraped row.

### Municipality and tourism offices

| Source | Address | Active | Listings | Experiences | Notes |
| --- | --- | --- | --- | --- | --- |
| Whale Coast Tourism pages | whalecoast.info/attraction/country-markets/ and /attraction/hermanus-first-friday-art-walk/ | Yes | 2 | 3 | First Friday Artwalk, Stanford Saturday Morning Market, Stanford Sunset Market. The site's events calendar page is empty; its events are in the two PDFs the seeded calendar sources fetch |
| Hermanus Tourism | hermanus-tourism.co.za/things-to-do/festivals-and-markets/ | Yes | 2 | 3 | First Friday ArtWalk, Akwaaba Market, Hermanus parkrun |
| Stanford Tourism | stanfordinfo.co.za and stanfordinbloom.co.za/event/stanford-sunset-market/ | Yes | 2 | 1 | Stanford Sunset Market, last Friday of the month, September to May |
| SANBI Harold Porter Botanical Garden | sanbi.org/event/carols-by-candlelight-4/ | Yes | 1 | 1 | Carols by Candlelight, 17 Dec 2026 |

### Organisers of festivals and races

| Source | Address | Active | Listings | Experiences | Notes |
| --- | --- | --- | --- | --- | --- |
| Hermanus FynArts pages | hermanusfynarts.co.za | Yes | 5 | 3 | 2027 festival 24 Jun to 4 Jul 2027, Old Harbour Sunset Concert 6 Mar 2027, Sculpture on the Cliffs. No 2028 edition announced |
| Hermanus Whale Festival pages | hermanuswhalefestival.co.za/events/ | Yes | 2 | 0 | Only the 2 to 4 Oct 2026 edition is shown. No next edition published |
| Kalfiefees | kalfiefees-hermanus.co.za | Yes | 3 | 1 | Expected in the first week of August 2027, month precision |
| Hemel-en-Aarde Wines | hemelenaardewines.com/celebrationevent, pnccelebration.co.za | Yes | 2 | 1 | Between Heaven and Earth Pinot Noir & Chardonnay Celebration, 30 Jan 2027 |
| Lighthouse 2 Lighthouse | lighthouse2lighthouse.co.za | Yes | 2 | 1 | The Official Walk, 11 to 14 Mar 2027 |
| Hermanus Trail Run | entryninja.com/events/83918-hermanus-trail-run, energyevents.co.za/hermanus-trail-run/ | Yes | 2 | 1 | 27 to 28 Feb 2027, Fernkloof and Walker Bay beach |
| Race2Hermanus triathlon | r2h.bikeruntri.co.za | Yes | 1 | 1 | 2 May 2027. Entries not open yet |
| Trail Series Kogelberg | trailseries.co.za/kogelberg | Yes | 2 | 1 | 15 Aug 2027, near Kleinmond. Entries not open yet |
| Boland Golf Union fixtures | bolandgolf.co.za/boland-golf-fixtures/ | Yes | 2 | 6 | Arabella Open, Arabella Junior Open, Hermanus Senior Open, Hermanus Junior Open, Kleinmond Open and Hermanus Open, April to December 2027 |
| KliK Kleinmond inniebos Kunstefees | capeculturalcollective.org.za/klik/ | Yes | 1 | 1 | 27 to 29 Nov 2026 |
| Fernkloof Nature Reserve | fernkloof.org.za | Yes | 1 | 0 | Flower show page shows only 24 to 27 Sep 2026. Guided walks are by request only |
| Hangklip Marathon | hangklipmarathon.co.za | Yes | 1 | 0 | Only the 25 Oct 2026 race is listed |
| Stanford in Bloom | stanfordinbloom.co.za/events/ | Yes | 2 | 0 | Only 12 to 27 Sep 2026 is listed |
| Wine Village Hermanus | winevillage.co.za | Yes | 1 | 0 | Host of the Hermanus Wine & Food Festival. The site does not mention the festival |
| Wines2Whales | epic-series.com/races/wines2whales | No | 1 | 0 | No 2027 dates published. Answers 403 to a plain fetch |

### Markets, venues, estates and operators

| Source | Address | Active | Listings | Experiences | Notes |
| --- | --- | --- | --- | --- | --- |
| Hermanus Country Market | hermanuscountrymarket.co.za | Yes | 1 | 2 | Saturday market 09:00 to 14:00, and Summer Night Markets on Wednesdays in December and January |
| Onrus Markie Facebook page | facebook.com/OnrusMarkie/ | No | 1 | 1 | First Saturday of the month. A plain fetch gets a login page |
| Hermanus Golf Club calendar | The club's public Google Calendar feed | Yes | 1 | 1 | Hermanus Open, 6 Dec 2026. The other entries are club competitions |
| Benguela Cove | benguelacove.co.za/products/ | No | 14 | 11 | Exhibition, parkrun, dinners, concerts and wine events to September 2027. Answers 429 to a plain fetch |
| Stanford Hills Estate | stanfordhills.co.za/events/ | Yes | 1 | 9 | Sunset Sessions concerts, 15 to 30 Dec 2026 |
| Southern Right Charters | southernrightcharters.co.za/whale-watching/ | Yes | 1 | 1 | Boat whale watching, daily June to November |
| Hermanus Whale Cruises | hermanus-whale-cruises.co.za/trip.php | Yes | 1 | 2 | Whale watching 1 Jun to 30 Nov, eco marine cruises December to May |
| Play Padel Hermanus | comeplaypadel.com | Yes | 1 | 1 | Beginner padel socials on Mondays at the Hermanus Sports Club |
| U3A Overberg | u3aoverberg.co.za | Yes | 1 | 1 | One public lecture, 27 Nov 2026 |

### Listings, the local paper and aggregators

| Source | Address | Active | Listings | Experiences | Notes |
| --- | --- | --- | --- | --- | --- |
| The Village NEWS What's On | thevillagenews.co.za/whats-on/ | Yes | 38 | 38 | The What's On page and the site's own events feed. Weekly items are published about three weeks ahead and were grouped into recurring experiences |
| Wesgro event pages | wesgro.co.za/travel/events/`<slug>` | Yes | 6 | 6 | The Cape Overberg category |
| Facebook events | facebook.com/events/`<id>`/ | No | 93 | 83 | Read only, in a logged-in Chrome. Found with the events search: "hermanus" with the Hermanus location filter, "stanford" with the Stanford filter, and searches for the other towns, Benguela Cove and Hermanus golf. Guest and friend names are left out of the captures. A plain fetch gets a login page |
| AllEvents.in event pages | allevents.in/`<town>`/`<slug>`/`<id>` | Yes | 69 | 60 | The Hermanus, Gansbaai, Kleinmond and Stanford pages, paged to the end and by month. Its town labels are often wrong; the town in the page text was used |
| Xplorio event pages | xplorio.com/`<town>`/ | Yes | 10 | 10 | The events pages for Hermanus, Stanford, Gansbaai, Kleinmond and Betty's Bay |
| SA-Venues | sa-venues.com/events/westerncape/hermanus-whale-festival/ | Yes | 1 | 1 | Hermanus Whale Festival, expected October 2027, month precision. Its Western Cape calendar lists nothing else in the Overstrand |
| Nosy Rosy directory | nosyrosy.co.za/lemms-corner-market-hermanus/ | Yes | 1 | 1 | Lemm's Corner Market, Sundays |

## Scraped and not loaded

| Capture | Why |
| --- | --- |
| Overstrand weekly diary (`overstrand-diary`) | The seeded "Overstrand weekly diary" fetches the same page |
| Whale Coast annual and monthly PDFs (`whalecoast`) | The two seeded calendar sources fetch the same files |
| hermanus.co.za (`hermanus-co-za`) | Its events calendar is a Google Calendar whose entries date from 2008 to 2015. The site then refused connections after two pages |
| Stanford Hills Estate, second capture (`stanford-hills-estate`) | The same page as `stanford-hills` |

Hermanus Times articles and winetourism.com were read and gave nothing to capture: 100 feed posts announced no dated event in the area, and winetourism.com lists only undated tastings.

## Looked up, with nothing to add

No dated or recurring experience in the window was published by: Arabella Country Estate and Golf, The Marine, Grootbos, Birkenhead House, Bientang's Cave, Rossouw Modern, Walker Bay Modern Art, Hermanus Astronomy Centre, the Old Harbour and Whale House museums, Hangklip-Kleinmond Tourism, and the wine estates Creation, La Vierge, Bouchard Finlayson, Newton Johnson, Ataraxia, Bartho Eksteen, Whalehaven, Hermanuspietersfontein, Springfontein, Raka, Lomond, Hamilton Russell, Sumaridge and Stanford Valley.

No site of its own was found for: the Kleinmond, Gansbaai and Betty's Bay markets, Art in the Park, the Hermanus Bird Club, the Whale Crier, the Municipal Auditorium, Sandbaai Hall, the Dutch Reformed Church concerts, Overstrand Arts/Kunste, the Hermanus Music Society, the Whale Coast Theatre, the Hermanus Hiking Club, Walkerbay Xtreme (its domain does not resolve), the Hermanus Whale Marathon, the Cliff Path Night Run, the Stanford Bird Fair and the Funky Fynbos Festival. Several of these appear as experiences through the calendars, Quicket, The Village NEWS and Facebook.

parkrun.co.za answered 403 to the scrape browser. The parkruns come from the Whale Coast annual calendar, Xplorio, Hermanus Tourism and Benguela Cove.

## Known duplicates

Two pairs of experiences are the same event under different titles and were not matched:

- "Alan Committie: AV-A-LAUGH-TA" and "Stand up Comedy: Alan Committie Live", Road House Cinema, 28 Nov 2026.
- "Secret Sunrise" and "Hermanus | Summer Opener | Secret Sunrise Cape Town", Grotto Beach, 28 Nov 2026.

## Sources with no kind

Found by the Hermanus source research and not read: the paid APIs PredictHQ, SerpApi Google Events and Bandsintown, and Eventbrite search (see [discovery.md](discovery.md)).
