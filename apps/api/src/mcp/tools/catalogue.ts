import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  experienceChangesInputSchema,
  experienceChangesResultSchema,
  searchExperiencesInputSchema,
  searchExperiencesResultSchema,
  type Catalogue,
} from "@magic-events/core/catalogue/ports.ts";
import { registerTool, type ToolDeps } from "../tool.ts";

// What an agent reads to decide when to call each tool and how. The allowed attribute options are the default
// definitions in packages/core/src/data-processing/default-attributes.ts and the tags those in default-tags.ts and
// the seeded seasons; a value that is not one of them is refused with the list of what can be used, so a definition
// added later still works.

const SEARCH_DESCRIPTION = `What is on near a place between two dates: festivals, concerts, sports matches, markets, \
theatre runs, exhibitions and seasonal experiences such as whale watching. Use it to plan a traveller's stay. To check \
back on a stay you searched before, use get_experience_changes instead of searching again.

The smallest call: {"location": "hermanus", "from": "2027-06-20", "to": "2027-06-30"}

Place: location, a location's slug such as hermanus, searches around its centre; near, a point {"lat", "lng"}, \
searches around that point. Give one, never both. radiusKm is 60 when left out, and at most 200.
Dates: from and to are the first and last day of the stay. An experience comes back only when one of its sessions \
falls inside them, so a show on Thursdays only is not returned for a stay with no Thursday.

Filters are exact and never loosened: put in them only what must hold. Put what the traveller likes in query, in \
plain words: it only orders the results, best match first. Examples:
- A family with a child of 10: {"location": "hermanus", "from": "2027-06-20", "to": "2027-06-30", "attributes": \
{"minimum_age": {"max": 10}}, "query": "fun for a family with a ten-year-old"}
- Only what can be booked now: {"location": "hermanus", "from": "2027-06-20", "to": "2027-06-30", "bookable": true}
- A couple who love art and nature: {"location": "hermanus", "from": "2027-06-20", "to": "2027-06-30", "query": \
"art, galleries, nature and wildlife, quiet"}

attributes filters by key. A list matches any of its values; {"min", "max"} is a number range. A range with only a \
max, such as minimum_age {"max": 12}, also keeps experiences with no minimum age recorded; a range with a min keeps \
only those that have one. The keys and their options:
- category: music, performing_arts, film, visual_arts, food_and_drink, sport, outdoor_and_adventure, \
nature_and_wildlife, culture_and_heritage, wellness, holidays_and_celebrations, hobbies_and_lifestyle, \
community_and_causes, faith_and_spirituality, business_and_professional
- format: performance, festival, market, fair_or_expo, exhibition, screening, match_or_tournament, race, \
tour_or_excursion, class_or_workshop, talk, conference, dining_event, party, retreat, parade_or_ceremony, attraction
- audience: family, all_ages, adults
- minimum_age: a number of years, as a range
- language: english, afrikaans, isixhosa, other
- setting: indoor, outdoor, both
- scale: local, regional, major
- wheelchair_accessible: true or false
tags matches any of its slugs, such as jazz, wine, whales, hiking or christmas. Season tags (whale-season, \
south-african-school-holidays, high-season, summer, autumn, winter, spring) are carried only by experiences whose \
dates all fall inside the season, so a weekly market that runs all year has none: to find what is on during a \
season, search its dates instead. An attribute key or option that does not exist is refused, and the error lists \
what can be used. Each tag in tags must be a tag or season slug; one that is not is refused, and the error names the \
closest slugs.

What comes back: items, best match first when query is given and otherwise by date, and total, how many match across \
all pages; page with limit (at most 100) and offset. Each item has its title and summary, its sessions inside the \
dates, status, bookable, booking, venue, distanceKm, price, attributes, tags, bookingUrl and pageUrl. Tell the person \
each experience's dates from its sessions; for a session of month or year precision, say the month or year and that \
the days are not announced yet. Say an experience is expected or announced rather than confirmed when it is, and \
give bookingUrl, or failing that pageUrl, only when bookable is true.

Limits: the feed covers Hermanus and the towns near it, so a place far from there returns nothing, and nothing is \
known beyond 24 months ahead. Cancelled and removed experiences are never returned here; get_experience_changes \
reports them.`;

const CHANGES_DESCRIPTION = `What changed for a place and dates searched before: what is new, confirmed, \
rescheduled, postponed, cancelled, removed or otherwise changed since then. Use it when checking back on a trip, \
weeks or months after planning it, instead of searching again and comparing. For a first look at a stay, use \
search_experiences.

Give the same place, dates and filters as the earlier search_experiences call, without query, and since: when you \
last searched, as an ISO timestamp, not in the future. Example: {"location": "hermanus", "from": "2027-06-20", "to": \
"2027-06-30", "since": "2027-02-01T09:30:00Z"}. tags is checked as in search_experiences: a slug that is no tag or \
season is refused, and the error names the closest.

Only experiences that changed after since come back; an empty answer means nothing changed. Each item has \
experience, as search_experiences returns it, and change, the change that matters most to a planner, with when it \
happened:
- new: published since then; you have not seen it before.
- confirmed: its dates are now fixed and it is going ahead.
- rescheduled: a date was added, moved or removed, or it has new dates after being postponed.
- postponed: it is not happening on its dates, and new dates are not known yet.
- cancelled: its organisers called it off.
- removed: no source lists it any more, and why is not known. Treat it as not happening unless you confirm otherwise.
- changed: anything else, such as the price, the venue, or booking opening or closing.
changes lists every change since then, newest first.

Every item has movedOut. True means it had a scheduled session inside the dates before a change made since since, \
and has none there now: treat it as no longer on during the stay. Its sessions are then the ones it has now, all \
outside the dates, or none. When movedOut is false, its sessions are the ones inside the dates.

Cancelled and removed experiences come back here, though search_experiences no longer returns them: this is how you \
learn that something planned around is off. Tell the person about those first. Experiences that are over never come \
back. The most recent change comes first; page with limit and offset.`;

export function registerCatalogueTools(server: McpServer, deps: ToolDeps, catalogue: Catalogue): void {
  registerTool(server, deps, {
    name: "search_experiences",
    action: "experiences.search",
    title: "Search what is on",
    description: SEARCH_DESCRIPTION,
    inputSchema: searchExperiencesInputSchema,
    outputSchema: searchExperiencesResultSchema,
    handler: (input) => catalogue.searchExperiences(input),
  });
  registerTool(server, deps, {
    name: "get_experience_changes",
    action: "experiences.changes",
    title: "What changed since a search",
    description: CHANGES_DESCRIPTION,
    inputSchema: experienceChangesInputSchema,
    outputSchema: experienceChangesResultSchema,
    handler: (input) => catalogue.getChangesSince(input),
  });
}
