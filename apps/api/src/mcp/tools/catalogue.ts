import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  experienceChangesInputSchema,
  experienceChangesResultSchema,
  searchExperiencesInputSchema,
  searchExperiencesResultSchema,
  type Catalogue,
} from "../../core/catalogue/ports.ts";
import { registerTool, type ToolDeps } from "../tool.ts";

const DESCRIPTION = `Find what is on near a place while a traveller is there: festivals, concerts, sports matches, \
markets, theatre runs, exhibitions and seasonal experiences such as whale watching.

Give the place, the first and last day of the stay (from, to) and, if you like, a radius in kilometres. The place is \
location, a location's slug such as hermanus, which searches around its centre; or near, a point, when the place is \
not a location. Dates match an experience's sessions, the stretches of time it is actually on, so a show that is on only \
on Thursdays is not returned for a stay with no Thursday in it. Each result carries only the sessions that fall \
inside the stay. A session with month or year precision means the experience is on in that month or year and its \
days are not announced yet.

Put everything that must hold in the filters: the dates, the place and radius, the audience (attributes.audience, \
such as family or adults), a minimum age (attributes.minimum_age, as { min, max }), the categories, the tags, and \
bookable when only experiences that can be booked now will do. Filters are exact and are never loosened. A maximum \
alone, such as attributes.minimum_age: { max: 12 }, also keeps experiences with no minimum age recorded. An attribute \
or an option that does not exist is refused, and the error lists the ones that do. Put what \
the traveller likes, in plain words, in query, such as "quiet, romantic, something to do with art": it only orders \
the results, best match first, and never adds or removes one.

Each result has its status (expected, announced, confirmed or postponed), whether it can be booked now (bookable: \
confirmed with booking open), its venue, distance, price, categories and other attributes, and tags. Results are \
paged with limit and offset, and total says how many match across all pages.`;

const CHANGES_DESCRIPTION = `Find out what changed for a place and dates you searched before. Use it when you check \
back on a trip, weeks or months after planning it, instead of searching again and comparing the results yourself.

Give the same search parameters as your earlier search_experiences call (location or near, radiusKm, from, to, and any status, \
bookable, attributes and tags), without query, and since: when you last searched, as an ISO timestamp such as \
2027-02-01T09:30:00Z. since must not be in the future. Only experiences that changed after since are returned; one \
that did not change is left out, so an empty answer means nothing changed.

Each result has the experience as search returns it, with its sessions inside the dates, and change: the change that \
matters most to a planner, with when it happened. The kinds:
- new: published since then; you have not seen it before.
- confirmed: its dates are now fixed and it is going ahead.
- rescheduled: a date was added, moved or removed, or it has new dates after being postponed.
- postponed: it is not happening on its dates, and new dates are not known yet.
- cancelled: its organisers called it off.
- removed: no source lists it any more, and why is not known. Treat it as not happening unless you confirm otherwise.
- changed: anything else, such as the price, the venue or booking opening or closing.
changes lists every change since then, newest first, so nothing is hidden.

Cancelled and removed experiences appear here, with that status, although search_experiences no longer returns them: \
this is how you learn that something you planned around is off. Experiences that are over are never reported. The \
most recent change comes first, and results are paged with limit and offset.`;

export function registerCatalogueTools(server: McpServer, deps: ToolDeps, catalogue: Catalogue): void {
  registerTool(server, deps, {
    name: "search_experiences",
    action: "experiences.search",
    title: "Search experiences",
    description: DESCRIPTION,
    inputSchema: searchExperiencesInputSchema,
    outputSchema: searchExperiencesResultSchema,
    handler: (input) => catalogue.searchExperiences(input),
  });
  registerTool(server, deps, {
    name: "get_experience_changes",
    action: "experiences.changes",
    title: "Get experience changes",
    description: CHANGES_DESCRIPTION,
    inputSchema: experienceChangesInputSchema,
    outputSchema: experienceChangesResultSchema,
    handler: (input) => catalogue.getChangesSince(input),
  });
}
