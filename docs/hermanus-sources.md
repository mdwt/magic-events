# Hermanus event sources: what can be fetched without a key

Checked on 23 Nov 2026 with `curl -sL --compressed` and a Chrome 130 desktop User-Agent (`Accept: text/html…`, `Accept-Language: en-ZA`). A handful of requests per site. Pages that failed a plain GET were opened in the `agent-browser` headless Chrome. "Size" is bytes on the wire (compressed where the server compressed).

## Summary table

| Source | Kind it fits | Address(es) to fetch | Plain GET works? | Needs a browser? | Better feed found | Events seen (with dates) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Overstrand Municipality, "Top Things to Do This Weekend" (the weekly Tourism Diary) | web_page | `https://www.overstrand.gov.za/top-things-to-do-this-weekend/` | Yes. 200, 53,559 B. The whole diary is HTML text, one line per event, grouped by day | No | The page also links the current annual and monthly PDFs (see next row) | Book Launch: Treasured Islands, Hermanus Library, Wed 18 Nov 2026 18:00. FynArts Select Weekend: Makers & Masters, 20 to 22 Nov. Louna Stofberg Organ Recital, Dutch Reformed Church Hermanus, Sun 22 Nov 11:30 | The best weekly source. It covers Hermanus, Stanford, Gansbaai, Kleinmond, Betty's Bay, Pringle Bay and Rooiels. Last modified 20 Nov 2026. It shows the diary for 18 to 22 Nov. The address stays the same each week. robots.txt allows it |
| whalecoast.info / Overstrand: annual and monthly events PDFs | pdf_calendar | Calendar page: `https://whalecoast.info/events-calendar/` (the PDFs are in the site menu on every page). Current annual PDF: `https://whalecoast.info/wp-content/uploads/2022/06/OM-Cape-Whale-Coast-Events-070826-1-1.pdf`. Current monthly PDF: `https://whalecoast.info/wp-content/uploads/2022/06/Tourism-November-Events-181126.pdf` | Yes. Page 200, 33,390 B. Annual PDF 200, 505,954 B. Monthly PDF 200, 430,711 B | No | Both PDFs have a text layer, so `pdftotext -layout` gives clean rows. The same PDFs are also served at stable addresses on overstrand.gov.za (see detail) | Annual: Kleinmond inniebos Kunstefees (KliK) 27 to 29 Nov. Stanford 100 Miler 5 Dec. Hawston Sea Festival 5 Dec. Trans Agulhas Boat Race 31 Dec. Monthly: Hermanus Business Chamber Gala Dinner, Hermanus Golf Club, 26 Nov 18:00. Hermanus Music Society Concert 27 Nov 17:45 | File names change with each reissue, as the docs expect. The annual PDF covers only 2026, so it has no 2027 dates yet. The December monthly PDF was not up on 23 Nov. robots.txt: `Disallow:` with nothing after it, so everything is allowed. There is no events API (`/wp-json/tribe/...` gives 404) |
| whalecoast.info weekly diary | not usable as a PDF. Use the Overstrand page above | `https://whalecoast.info/wp-content/uploads/2022/06/Tourism-Diary-18-22-Nov-2026-scaled.png` | 200, 2,219,204 B, but it is a **PNG image** | No | The same diary is HTML text on overstrand.gov.za (row 1) | The same events as row 1 | The docs list the "Overstrand weekly diary" as a PDF calendar. On whalecoast.info it is now an image, and on overstrand.gov.za it is HTML. Neither is a PDF |
| Quicket public site (no API key) | web_page | `https://www.quicket.co.za/events/south-africa?search=hermanus` and page 2 at `https://www.quicket.co.za/events/south-africa/2/?search=hermanus`. The same works for `search=stanford`, `search=gansbaai` and `search=kleinmond` | Yes. 200, 4,375 B. The body is an Angular shell, but it carries **20 JSON-LD `Event` blocks per page** with name, start and end in UTC, venue, locality and URL | No | JSON-LD `Event` in the search page. It is much better than the page's visible text | Hermanus Summer Opener, Secret Sunrise, Grotto Beach, 28 Nov 2026 05:00Z. Hermanus Pride Party, Fick's Pool, 5 Dec 2026. BNC#10 BizNews Conference, Hermanus Auditorium, 8 to 12 Mar 2027. Andrew Young Live @ Benguela Cove, 9 Jan 2027. Gansbaai: Lomond "Blessing of the Harvest" 7 Jan 2027 | This answers question 5. Quicket's own search page returns Hermanus events with no key. The search is a text search, so there is noise (page 2 had a Cape Town jazz gig for "Muneeb **Hermans**" and a Durban show). Filter on `location.address.addressLocality`. "hermanus" gave 28 results over 2 pages. robots.txt blocks only named bad bots and has no `User-agent: *` section. Terms not checked |
| AllEvents.in, Hermanus | web_page | `https://allevents.in/hermanus` (28 JSON-LD Events) and `https://allevents.in/hermanus/all` (about 47 dated events in the HTML) | Yes. `/hermanus` 200, 89,005 B. `/hermanus/all` 200, 114,859 B | No | JSON-LD `Event` on `/hermanus`. RSS at `https://allevents.in/hermanus/RSS` (200, 11,396 B, 49 items) has **no event dates**, only title, link, description and image, so the HTML is better | Rosoberry Harvest Fest, Hermanus River Farm, 28 Nov 2026. Hermanus Carols 2026, Attie Bishop Stadium, 15 Dec 2026. Jeremy Loops in Stanford, Stanford Hills Estate, 23 Dec 2026. The Met Opera: Otello, Whale Coast Mall cinema, 3 May 2027 | Covers Hermanus, Sandbaai, Onrus, Fisherhaven, Stanford and Kleinmond. Much of it overlaps with Quicket. robots.txt sets `Crawl-delay: 10` for ClaudeBot and disallows nothing under `/hermanus`. `/hermanus/all` shows no paging links in the HTML, and I did not check whether more load with JavaScript. I could not find AllEvents' terms page, so its terms are unverified |
| Wesgro travel events, Cape Overberg | web_page | `https://www.wesgro.co.za/travel/events?category=416162` (all events: `https://www.wesgro.co.za/travel/events`) | Yes. 200, 19,451 B. Server-rendered list with date, title and town | No | None. No JSON-LD Event and no feed | KliK, Kleinmond, 27 to 29 Nov 2026. The Stanford Stumble, 28 Nov 2026. TITAN Trail Run, Benguela Cove, 6 Dec 2026. Toy Run Overberg, Gansbaai, 29 Nov 2026 | About 9 events. One is out of region (a Cape Town show). One page per event at `/travel/events/<slug>`. The "Show more" links expand descriptions, not paging. robots.txt disallows only `/craft/`. The terms say nothing about automated access. `/corporate/events` is conferences only. Not useful |
| Hermanus Times | rss_feed | `https://novanews.co.za/hermanustimes/feed/` | Yes. 200, 17,109 B, 10 items with full text | No | None | Latest post 17 Nov 2026 ("Immediate evacuation ordered as fire breaks out above Mount Pleasant"). Mostly national sport | As the docs say. News, not a listings source |
| Hermanus Scoop (weekly newsletter) | web_page | Archive: `https://hermanusscoop.beehiiv.com/archive?page=1`. Latest issue: `https://hermanusscoop.beehiiv.com/p/find-your-village-helpers-hikes-and-a-whole-lot-of-art` | Yes. Archive 200, 28,548 B. Post 200, 88,809 B | No | No public RSS (`/feed` redirects to a 404, and the page data has `"rss_feeds":[]`) | Issue of 18/19 Nov 2026, with a "What's On" section: FynArts Select 20 to 22 Nov, listed day by day. Issues on 19 Nov, 12 Nov, 5 Nov, 29 Oct… | A new address every week. The archive page lists the issues newest first with dates, so it works like the PDF calendar: fetch the archive, then the newest post. Prose, so it needs the language model. robots.txt blocks only Amazonbot fully and login and poll paths for others |
| Hermanus FynArts | web_page | `https://www.hermanusfynarts.co.za/event-list` | Yes. 200, 267,591 B. A Wix site, rendered on the server | No | None (no JSON-LD Event) | FynArts Old Harbour Sunset Concert, Old Harbour, Sat 6 Mar 2027. 2027 Hermanus FynArts Festival, from Thu 24 Jun 2027 (the home page says 24 Jun to 4 Jul 2027) | Two upcoming events. This covers the brief's "FynArts June 2027". robots.txt allows `/` |
| Hermanus Whale Festival | web_page, but the site's own JSON is better | `https://hermanuswhalefestival.co.za/wp-json/tribe/events/v1/events` (The Events Calendar REST, upcoming by default) | Yes. 200, 182 B. Today it returns `total: 0` | No | Yes, The Events Calendar REST JSON. With `?start_date=2026-01-01` it returns the 2026 festival: 19 events, 10 per page, `page=` for paging. The site also advertises RSS `/feed/` and iCal `/events/?ical=1`, but the iCal returned 0 bytes | None upcoming. Past: 10km Whale Festival Fun Run 3 Oct 2026, Whales and Wheels Classic Car Show 3 Oct 2026 | The 2027 programme is not published yet. Worth keeping, because the REST endpoint will show it when it is. JSON is not one of the five kinds as written ("one page, as HTML"). robots.txt allows it |
| Xplorio Hermanus | web_page (thin) | `https://xplorio.com/hermanus/en/things-to-do/events/` | Yes. 200, 26,667 B | No | None | Deli Dining at Dal-Italia, every Friday from 27 Nov 2026. Benguela Cove Parkrun, every Saturday from 28 Nov 2026 | Only 2 events listed, both weekly. Sub-category pages exist (markets, festivals, sport…). robots.txt is permissive |
| Webtickets | web_page, one page per event only | Example: `https://www.webtickets.co.za/v2/event.aspx?itemid=1604981085` | Event pages yes (200, 20,491 B, title and date in the HTML). The search page `…/v2/search.aspx?q=hermanus` is a JavaScript shell (200, 15,545 B, no results) | Yes, for search. In the browser, searching "hermanus" goes straight to one event page. No results list was shown and no JSON endpoint was called | None | Hermanus Carols 2026, 15 Dec 2026 18:30 | There is no Hermanus listing page to fetch on a schedule. Useful only to check a known event. robots.txt disallows only `/eventmanager/` paths |
| restaurants.co.za, Hermanus specials and events | web_page (marginal) | `https://www.restaurants.co.za/specials/western-cape/hermanus` (paging `/page/2`, `/page/3`) | Yes. 200, 12,269 B | No | None | Great Gatsby New Year's Eve at Benguela Cove (31 Dec 2026). "Dancing Queen: The Ultimate ABBA Experience" | Mostly restaurant offers ("valid until 30 November 2026"), with a few dated events. robots.txt allows it |
| Computicket | not usable (no Hermanus events, API protected) | `https://computicket.com/event/list?keyword=hermanus` | No. A plain GET of a search address redirects to the home shell (27,496 B, no events) | Yes. The browser renders "No events found matching your criteria" | The page calls `GET /api/events/autocomplete/hermanus` (`{"matches":[],"alternatives":[]}`) and `POST /api/events/lookup?summary=true` (`{"totalRecords":0}`). A plain POST to the lookup gives **403 `SEC_001`**, because the page sends a CSRF token, a bearer token and JS-challenge headers | None | Not pursued further. Calling it would mean solving their JS challenge |
| Ticketmaster South Africa | not usable (no Hermanus events) | `https://www.ticketmaster.co.za/search/?keyword=hermanus` | Yes. 200, 92,908 B. The page says "0 Results for "hermanus"… No Upcoming Events" (the same for `overstrand`) | No | None | None | Answers question 5: Ticketmaster holds no Hermanus events today. robots.txt disallows `/json/search/*` and `/search.php` |

**Count:** 13 sources return events to a plain GET (the first 13 rows, with Xplorio, Webtickets and restaurants.co.za the weakest). One needs a browser for its listing and has nothing to show for Hermanus (Computicket). Its API is blocked by a JavaScript challenge. Ticketmaster answers a plain GET but has no Hermanus events.

---

## Detail per source

### 1. Overstrand "Top Things to Do This Weekend" (weekly Tourism Diary)

- Address: `https://www.overstrand.gov.za/top-things-to-do-this-weekend/`. The municipality's `/events` page links to it as "VIEW EVENTS CALENDAR". `/events` itself is about applying for event permits, not listings.
- `curl` → `200 53559 text/html`. `article:modified_time` 2026-11-20T14:36:22. The diary is plain text bullets under day headings ("Wednesday 18th November 2026", and so on), in the form "Title time venue town".
- Shape: one page holds the whole week. No paging. Recurring weekly and monthly events are left out of the diary, as the whalecoast PNG states. Parkrun and the markets appear only as one-line reminders.
- The same page links the current annual and monthly PDFs through a document manager. Both served PDFs with a plain GET:
  - `https://www.overstrand.gov.za/~documents/meeting-events-calendar/tourism-events/tourism-november-2026-events/?layout=file` → `200 430711 application/pdf` (the same file as whalecoast's `Tourism-November-Events-181126.pdf`).
  - The annual calendar sits at `…/tourism-events/tourism-august-events-050826/?layout=file` (its slug says "august", but the title is "Annual Events Calendar" and the file is `OM Cape Whale Coast Events 070826.pdf`).
  - These overstrand.gov.za document slugs look stable within a month, but they also change with each reissue.
- robots.txt disallows `/feed/`, `/*/feed/`, `/wp-json/` and `/?rest_route=`. **So the WordPress feeds and REST API are off-limits by robots.** The page itself is allowed.

### 2. whalecoast.info PDF calendars

- `https://whalecoast.info/events-calendar/` → 200, 33,390 B. The body says "No posts were found". The PDFs are linked from the site-wide menu, with these labels:
  - "Annual events" → `…/2022/06/OM-Cape-Whale-Coast-Events-070826-1-1.pdf`
  - "November Events" → `…/2022/06/Tourism-November-Events-181126.pdf`
  - "Overstrand Tourism Diary 18 November – 22 November 2026" → `…/2022/06/Tourism-Diary-18-22-Nov-2026-scaled.png` (an image)
  - "2026 Environmental Days" → `…/2022/06/EnvironmentalCalendar2-2-2026.pdf`
- All uploads sit under `/wp-content/uploads/2022/06/` whatever their date. The file name carries a DDMMYY issue date. The overstrand.gov.za home page still links an older annual file (`OM-Cape-Whale-Coast-Events-220424.pdf`), so the whalecoast menu is the place to find the current file.
- Annual PDF (2 pages, text layer): a "DATE | EVENT/FESTIVAL | REGION | CONTACT" table for all of 2026, plus footnotes on recurring events. ParkRun every Saturday 8:00 at Groeneweide Gansbaai, Harold Porter Betty's Bay, Hemel-en-Aarde and Benguela Cove. First Friday Artwalk on the first Friday of the month. Art in the Park on the first Sunday of the month at the Country Market venue.
- Monthly PDF (2 pages, text layer, created 18 Nov 2026): an "Events | November Dates | Time | Venue | Town" table.
- robots.txt allows everything. Sitemap: `https://whalecoast.info/sitemap_index.xml` (posts, pages, tours, destinations). It has no events. `/wp-json/tribe/events/v1/events` → 404 `rest_no_route`.

### 3. Quicket without a key

- `https://www.quicket.co.za/events/?search=hermanus` redirects to `https://www.quicket.co.za/events/south-africa?search=hermanus` → 200. The visible HTML is an empty Angular shell (54 characters of text). The `<script type="application/ld+json">` blocks hold 20 `Event` objects with `name`, `startDate` and `endDate` (UTC `Z`), `location.name`, `location.address.addressLocality`, and `url` (`https://www.quicket.co.za/events/<id>-<slug>/`).
- Paging: `/events/south-africa/2/?search=hermanus` → 8 more events. That makes 28 in total for "hermanus".
- Other towns: `search=stanford` gave Stanford Hills and Walker Bay events plus noise from Sandton and Johannesburg. `search=gansbaai` gave five Lomond Wine Estate events.
- One listing per event, as JSON-LD, which fits field mapping as well as the language model. The listing ID is the number in the URL.
- robots.txt: about 138 `Disallow: /` lines, each for a named bot (PetalBot, SemrushBot, Python-urllib…). There is no `User-agent: *` group. Note that `Python-urllib` is blocked by name, so the fetch must send a real User-Agent.

### 4. AllEvents.in

- `https://allevents.in/hermanus` → 200, 89,005 B. It has 28 JSON-LD `Event` blocks (startDate, name, location, url) and an FAQ block with lines like "is happening on Sat 28 Nov 2026 from 10:00 AM…".
- `https://allevents.in/hermanus/all` → 200, 114,859 B. About 47 distinct event links with dates such as "Sat, 28 Nov, 2026 - 10:00 AM". There is no JSON-LD on this page.
- Category pages exist (`/hermanus/music`, `/hermanus/art`, `/hermanus/parties`) and `/hermanus/this-weekend`.
- `https://allevents.in/hermanus/RSS` → 200, 49 items, but the items have no date fields.
- Event pages: `https://allevents.in/hermanus/<slug>/<id>`. One page per event.
- robots.txt: `ClaudeBot Crawl-delay: 10`. ShapBot and HaloBot are fully disallowed. Old-year date paths and `?ref=` variants are disallowed. `/hermanus` is not disallowed.

### 5. Wesgro

- Leisure events: `https://www.wesgro.co.za/travel/events`. Region filter for Cape Overberg: `?category=416162`. Other ids: Cape Town 10808, Winelands 215780, Karoo 416158, West Coast 416164, Garden Route 416160.
- Server-rendered list: date, title and "Town, Cape Overberg", linking to `/travel/events/<slug>`. No JSON-LD Event. There is an Algolia-style search form (`refinementList[siteName]`), but the region page needs no JavaScript.
- robots.txt disallows only `/craft/`. `https://www.wesgro.co.za/global/terms-of-service` has nothing on scraping or automated access.

### 6. Hermanus Times

- As in the docs. Verified again: `200 17109 application/rss+xml`. The newest item is 17 Nov 2026.

### 7. Hermanus Scoop

- A weekly beehiiv newsletter with a "What's On" section. The archive at `https://hermanusscoop.beehiiv.com/archive?page=1` lists issues dated Nov 19, Nov 12, Nov 05, Oct 29… with links to `/p/<slug>`.
- The posts are server-rendered (88,809 B). Events appear as prose and day lists under "What's On:".
- No RSS: the page data has `"rss_feeds":[]`, and `/feed` redirects to the 404 page.
- robots.txt: Amazonbot is fully disallowed. Others are blocked only from login and poll-result paths.

### 8. Hermanus FynArts

- `https://www.hermanusfynarts.co.za/event-list` (Wix Events, rendered on the server). It lists "FynArts Old Harbour Sunset Concert, Sat 06 Mar, Old Harbour, Hermanus" and "2027 Hermanus FynArts Festival, Multiple Dates, Thu 24 Jun, Location is TBD".
- The home page adds "FynArts Festival: 24 June 2027 – 4 July 2027".
- The 2026 programme pages (`/2026-festival`, `/performances`, `/workshops`) are static content pages.
- robots.txt is `Allow: /`.

### 9. Hermanus Whale Festival

- The site runs The Events Calendar. `https://hermanuswhalefestival.co.za/wp-json/tribe/events/v1/events` → 200 `{"events":[],"total":0,…}`. The default window is from today to two years ahead.
- With `?start_date=2026-01-01` → 19 events, `total_pages: 2`, full JSON per event (title, start_date, venue, cost, url).
- `/events/?ical=1` → 200 with an empty body. `/feed/` is advertised but was not fetched.
- The festival ran 2 to 4 Oct 2026. The 2027 dates are not published.

### 10. Xplorio

- `https://xplorio.com/hermanus/` redirects from `/hermanus/events/`. The events list is at `https://xplorio.com/hermanus/en/things-to-do/events/` and shows two weekly events with a "Future events…" expansion that lists each date.
- Category pages: `…/events/hermanus-markets/`, `hermanus-festivals/`, `hermanus-sport/`, `hermanus-special-events/`, `hermanus-club-events/` and `hermanus-workshops/`. I did not fetch them.
- Xplorio also has a Stanford site (seen in search results, not fetched).

### 11. Webtickets

- Search (`/v2/search.aspx?q=hermanus`) has no results in its HTML. In the headless browser, both Enter and "GO" went straight to one event page (`event.aspx?itemid=1604981085`, Hermanus Carols 2026). There was no results list and no search XHR (network log checked).
- Event pages work with a plain GET (title and date in the HTML). No listing address was found, so it cannot be a scheduled source by location.

### 12. Computicket

- `https://www.computicket.com/search?q=hermanus` → redirected to the home page shell. In the browser, the search form goes to `https://computicket.com/event/list?keyword=hermanus` and shows "No events found matching your criteria".
- JSON calls seen in the HAR: `/api/csrf` (returns a CSRF token and a JS challenge), `/api/events/autocomplete/hermanus` (empty), and `POST /api/events/lookup?summary=true` (`{"size":30,"from":1,"location":{"gps":{…}},"keyword":["hermanus"]}` → `{"totalRecords":0}`).
- A direct POST without the page's tokens → `403 {"success":false,"message":"SEC_001"}`. This is a bot check, so I did not try further.

### 13. Ticketmaster

- `https://www.ticketmaster.co.za/search/?keyword=hermanus` (the address from the site's own `SearchAction` JSON-LD) → server-rendered "0 Results for "hermanus"". The same for "overstrand".
- The Discovery API needs a key, as in the docs.

### 14. restaurants.co.za

- `https://www.restaurants.co.za/specials/western-cape/hermanus`. Paging via `/page/N` and `/order/date/page/N` (seen in search results).
- Mostly offers and set menus. Some are events (New Year's Eve at Benguela Cove, ABBA show, sculpture exhibition).

---

## Not usable, and why

- **SA-Venues.** `https://www.sa-venues.com/events/westerncape/hermanus/` and `…/suburb/hermanus/` both redirect to the Western Cape list, which has 5 events and none in the Overstrand. The event page `…/events/westerncape/hermanus-whale-festival/` is stale ("To be confirmed - October 2026", "2027 dates are still to be confirmed").
- **hermanus.co.za.** Its "Events Calendar" (`/what-to-do/events-calendar/index.html`) embeds a public Google Calendar. Its iCal (`https://calendar.google.com/calendar/ical/gps3sfuqn1pp1uen5ed0gg40h8%40group.calendar.google.com/public/basic.ics`, 200, 853 VEVENTs) has **no dated event after 11 Jan 2020**. Only old weekly and monthly recurrence rules remain (Country Market Saturdays, First Fridays Artwalk, Art in the Park "last Sunday", which conflicts with whalecoast's "first Sunday"). The site footer says © 2020.
- **hermanuswineroute.com.** The domain now serves gambling reviews. It is not a wine route site.
- **Stanford Tourism (stanfordinfo.co.za/events/).** The page is a Facebook page-plugin embed (tabs=events) and has no events in the HTML. `/wp-json/tribe/events/v1/events` gives 404. Facebook events are closed, per the docs.
- **Hermanus Country Market (hermanuscountrymarket.co.za).** It states only its recurring hours: every Saturday 9:00 to 14:00, plus Summer Night Markets on Wednesdays 17:00 to 21:00 in December and January. There are no dated listings. Its `/feed/` was not checked.
- **Wesgro corporate events** (`/corporate/events`). Business conferences, mostly past.
- **Overstrand `/events`.** A page for event-permit applications, not listings.
- **Computicket.** No Hermanus events, and the API is behind a JS challenge (403 `SEC_001`).
- **Ticketmaster.** No Hermanus events on the public site, and the API needs a key.
- **whalecoast.info weekly diary as a PDF.** It is a PNG now. Use the Overstrand HTML page instead.

## Not verified

- Parkrun event pages. `https://www.parkrun.co.za/hemelenaarde/` gave 404, and I did not search for the right slugs. Parkrun is weekly and is already covered by the annual PDF footnote and by Xplorio (Benguela Cove).
- Individual Hemel-en-Aarde wine estate and theatre or gallery sites. I found no listing addresses I could confirm without guessing. Estates show up through Quicket, AllEvents and Wesgro instead: Benguela Cove, Stanford Hills, Lomond, Bartho Eksteen, Wildekrans, Walker Bay.
- The terms of AllEvents and Quicket. I did not find their terms pages.
- Whether AllEvents `/hermanus/all` loads more events with JavaScript beyond the roughly 47 in the HTML.
