import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  searchExperiencesInputSchema,
  searchExperiencesResultSchema,
  type Catalogue,
} from "../../core/catalogue/ports.ts";
import { registerTool, type ToolDeps } from "../tool.ts";

const DESCRIPTION = `Find what is on near a place while a traveller is there: festivals, concerts, sports matches, \
markets, theatre runs, exhibitions and seasonal experiences such as whale watching.

Give the point to search around (near), the first and last day of the stay (from, to) and, if you like, a radius in \
kilometres. Dates match an experience's sessions, the stretches of time it is actually on, so a show that is on only \
on Thursdays is not returned for a stay with no Thursday in it. Each result carries only the sessions that fall \
inside the stay. A session with month or year precision means the experience is on in that month or year and its \
days are not announced yet.

Put everything that must hold in the filters: the dates, the place and radius, the audience (attributes.audience, \
such as family or adults), a minimum age (attributes.minimum_age, as { min, max }), the categories, the tags, and \
bookable when only experiences that can be booked now will do. Filters are exact and are never loosened. Put what \
the traveller likes, in plain words, in query, such as "quiet, romantic, something to do with art": it only orders \
the results, best match first, and never adds or removes one.

Each result has its status (expected, announced, confirmed or postponed), whether it can be booked now (bookable: \
confirmed with booking open), its venue, distance, price, categories and other attributes, and tags. Results are \
paged with limit and offset, and total says how many match across all pages.`;

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
}
