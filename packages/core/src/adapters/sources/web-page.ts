import { z } from "zod";
import type { FetchedListing, SourceFetcher } from "../../discovery/ports.ts";
import { fingerprintContent, sharedLines } from "../../shared/html.ts";
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
      const pages: { url: string; html: string }[] = [];

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

        pages.push({ url, html: textOf(response) });
        logger.debug({ url, bytes: response.body.byteLength }, "Fetched a page");
      }

      // Markup, tokens, adverts, the site's frame and the lines all its pages show change on every fetch; what each
      // page says does not.
      const siteLines = sharedLines(pages.map((page) => page.html));
      const listings: FetchedListing[] = pages.map(({ url, html }) => ({
        sourceListingId: url,
        url,
        contentType: "text/html",
        content: html,
        fingerprintOf: fingerprintContent(html, siteLines),
      }));

      return { listings, complete: true, syncState: {} };
    },
  };
}
