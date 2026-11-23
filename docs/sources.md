# Sources

Source of truth for which sources the system reads for Hermanus, where each one is, how it is read and what the last scrape got from it. The source kinds, the fetch port and the fetch flow are in [discovery.md](discovery.md). How a listing becomes an experience is in [data-processing.md](data-processing.md).

2026-11-23 · Meiring

## Coverage

| | |
| --- | --- |
| Location | Hermanus, with the surrounding Overstrand: Onrus, Vermont, Sandbaai, Hawston, Fisherhaven, Voëlklip, Hemel-en-Aarde, Stanford, Kleinmond, Betty's Bay, Pringle Bay, Gansbaai, De Kelders |
| Window | Experiences on from the scrape date to 24 months ahead |
| Seeded as source rows | Quicket, Ticketmaster and the Hermanus Times feed (`apps/api/src/seed/data/sources.ts`). The rest are not source rows yet |

## Scrape of 23 Nov 2026

The first real data is scraped with the agent-browser CLI: a headless Chrome driven page by page, the way a person browses the site. No API key is set for Quicket or Ticketmaster, so this run reads their public sites too.

- **Finding listings:** the site's own search, its town filter, its events calendar, and pagination to the end. Each town in the coverage is searched, not only Hermanus.
- **Reading a listing:** the listing's own detail page is opened and the fields are taken from it. A search-result card is never the source of a field.
- **PDF calendars:** the link is found in the browser, the file is downloaded and the PDF is read whole.
- **Raw captures:** `data/hermanus/raw/<source>/`, one file per listing page with its address, the fetch time and the page's visible text, or the PDF itself.
- **Extracted experiences:** `data/hermanus/extracted/<source>.json`, one object per experience in the extracted experience shape from [data-processing.md](data-processing.md), with the source's listing ID, the listing's address and the raw file it came from.
- **Blocked sites:** a site that turns the browser away is tried once more with a visible browser window, then recorded as blocked.

The result column in the tables below is filled in per source as the run finishes.

## Ticketing sites

| Source | Address | Kind | How it is read | Result of the 23 Nov 2026 scrape |
| --- | --- | --- | --- | --- |
| Quicket | quicket.co.za/events | Quicket (API, key needed). Scraped as a web page in this run | The events page is a single-page app and its search runs on Algolia. The `?q=` address parameter does not filter the list, so the search box and the city, region and venue filters are used. Detail pages are `quicket.co.za/events/<id>-<slug>/`, and the number is Quicket's event ID | Running |
| Ticketmaster South Africa | ticketmaster.co.za | Ticketmaster (API, key needed). Scraped as a web page in this run | Site search and location browsing, per town | Running |
| Computicket | computicket.com | Web page | Site search and region and venue filters, per town | Running |
| Webtickets | webtickets.co.za | Web page | Site search, per town. Also sells boat trips, festival tickets and reserve entries | Running |

## Official calendars

| Source | Address | Kind | How it is read | Result of the 23 Nov 2026 scrape |
| --- | --- | --- | --- | --- |
| Whale Coast Tourism annual events calendar | whalecoast.info | PDF calendar | The events page is opened, the current annual PDF is picked from its links and read. File names change with each reissue | Running |
| Whale Coast Tourism monthly events calendars | whalecoast.info | PDF calendar | As above, for every current and upcoming month | Running |
| Overstrand Municipality weekly diary | overstrand.gov.za | PDF calendar | The current issue is found through the site's navigation or search and read | Running |

## Organisers' own sites

One source per organiser site. A festival is one experience per edition; its programme items are not extracted. The sites are found by searching for the event in the browser, and each address is recorded here once the site is opened.

| Event | Address | Kind | Result of the 23 Nov 2026 scrape |
| --- | --- | --- | --- |
| Hermanus FynArts | | Web page | Running |
| Hermanus Whale Festival | | Web page | Running |
| Hermanus Wine & Food Festival | | Web page | Running |
| Hermanus Flower Festival | | Web page | Running |
| Kalfiefees | | Web page | Running |
| Walkerbay Xtreme | | Web page | Running |
| Hermanus Pinot Noir Celebration and Hemel-en-Aarde wine valley events | | Web page | Running |
| Races: Whale Marathon, Lighthouse 2 Lighthouse, Wines2Whales, Cliff Path night run, Marine Mile and Walker Bay open water swims | | Web page | Running |
| Whales and Wheels classic car show | | Web page | Running |
| Stanford festivals and markets (Stanford Tourism) | | Web page | Running |
| Gansbaai festivals (Gansbaai Tourism), Funky Fynbos Festival | | Web page | Running |
| Kleinmond, Betty's Bay and Pringle Bay festivals | | Web page | Running |

## Recurring experiences, venues, estates and hotels

Things with no ticketing feed. One source per site. A standing weekly or monthly experience is taken as a recurrence from the site's own statement of when it is on. A venue or estate gives one experience per dated show, concert, exhibition or dinner. A place that is simply open, with opening hours and no dates, is not an experience.

| Group | What is looked up | Kind | Result of the 23 Nov 2026 scrape |
| --- | --- | --- | --- |
| Markets | Hermanus Country Market, Hermanuspietersfontein Food & Wine Market, Die Markie, and the markets of Onrus, Stanford, Kleinmond, Gansbaai and Betty's Bay | Web page | Running |
| Art | Hermanus First Fridays Artwalk, Art in the Park, galleries with dated exhibitions | Web page | Running |
| parkrun | Hermanus parkrun and the other Overstrand parkruns, on parkrun.co.za | Web page | Running |
| Nature and societies | Boat-based whale watching with stated seasons, Fernkloof Nature Reserve walks, Hermanus Botanical Society, Hermanus Bird Club, Hermanus Astronomy Centre, U3A Overberg, Old Harbour Museum, Hermanus History Society, Harold Porter Botanical Garden | Web page | Running |
| Venues with a programme | Hermanus Municipal Auditorium, Sandbaai Hall, Dutch Reformed Church concerts, Overstrand Arts/Kunste (OAK) concert series, Hermanus Music Society, the library, the cinema, live-music venues | Web page | Running |
| Wine estates | Creation, Bouchard Finlayson, Hamilton Russell, Newton Johnson, Ataraxia, La Vierge, Sumaridge, Bartho Eksteen, Benguela Cove, Whalehaven, Hermanuspietersfontein, Stanford Hills, Stanford Valley, Springfontein, Raka, Lomond | Web page | Running |
| Hotels and lodges | The Marine, Arabella Hotel Golf & Spa, Birkenhead House, Grootbos, The Thatch House, Bientang's Cave, Mosaic Lagoon Lodge | Web page | Running |
| Golf | Hermanus Golf Club and Arabella open days and tournaments | Web page | Running |

## Aggregators, directories and local news

Aggregators carry stale and duplicated listings. Each listing is extracted as that site gives it, and matching across sources happens in processing.

| Source | Address | Kind | How it is read | Result of the 23 Nov 2026 scrape |
| --- | --- | --- | --- | --- |
| AllEvents.in | allevents.in/hermanus | Web page | The Hermanus city page and the pages of nearby towns, paged to the end and by month | Running |
| SA-Venues | sa-venues.com | Web page | Its events calendar for Hermanus, the Overberg and the Whale Coast | Running |
| Xplorio | xplorio.com/hermanus | Web page | Its what's-on listing for Hermanus and the nearby towns | Running |
| Wesgro | wesgro.co.za | Web page | Its events calendar, filtered to the Overberg and the Cape Whale Coast | Running |
| hermanus.co.za and Hermanus Tourism | hermanus.co.za | Web page | The town portal's events calendar | Running |
| Hermanus Times | novanews.co.za/hermanustimes/feed/ | RSS feed | 10 posts a page, `?paged=N` for older posts, about 8 pages back. Most posts are national news; only posts that announce a dated event in the area are kept. Category pages, the posts API and sitemaps sit behind a Cloudflare check | Running |
| The Village NEWS | thevillagenews.co.za | Web page | Its What's On page | Running |
| winetourism.com | winetourism.com | Web page | Its listings for Hermanus wine events | Running |

## Sources with no kind

Found by the Hermanus source research and not read: the paid APIs PredictHQ, SerpApi Google Events and Bandsintown, and the closed sources Facebook events and Eventbrite search (see [discovery.md](discovery.md)).
