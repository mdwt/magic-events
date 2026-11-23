import { z } from "zod";
import type { FetchedListing, SourceFetcher } from "../../discovery/ports.ts";
import { pageContent } from "../../shared/html.ts";
import type { Logger } from "../../shared/logger.ts";
import { HttpStatusError, MAX_PAGE_BYTES, parseSettings, textOf, type Http } from "./http.ts";

// The web page adapter: one listing per address in the source's settings, the HTML as returned.
// A run is complete. An address that answers not found or gone is a missing listing; any other failure fails the run.

const settingsSchema = z.strictObject({
  urls: z.array(z.url()).min(1),
});

const MISSING = new Set([404, 410]);

export function createWebPageFetcher(deps: { http: Http; logger: Logger }): SourceFetcher {
  const logger = deps.logger.child({ adapter: "web_page" });
  return {
    kind: "web_page",

    async fetch(input) {
      const settings = parseSettings("web_page", settingsSchema, input.settings);
      const listings: FetchedListing[] = [];

      // One page after another, so a site is never sent several requests at once.
      for (const url of new Set(settings.urls)) {
        let response;
        try {
          response = await deps.http.get(url, {
            accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.8",
            maxBytes: MAX_PAGE_BYTES,
          });
        } catch (error) {
          if (error instanceof HttpStatusError && MISSING.has(error.status)) {
            logger.info({ url, status: error.status }, "A page is not found, so it is missing from this run");
            continue;
          }
          throw error;
        }

        const html = textOf(response);
        listings.push({
          sourceListingId: url,
          url,
          contentType: "text/html",
          content: html,
          // Markup, tokens and adverts change on every fetch; what the page says does not.
          fingerprintOf: pageContent(html),
        });
        logger.debug({ url, bytes: response.body.byteLength }, "Fetched a page");
      }

      return { listings, complete: true, syncState: {} };
    },
  };
}
