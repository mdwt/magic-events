import type { SourceFetcher } from "../../discovery/ports.ts";
import type { LanguageModel } from "../../shared/language-model.ts";
import type { Logger } from "../../shared/logger.ts";
import type { DiscoverySettings } from "../../shared/settings.ts";
import { createHttp } from "./http.ts";
import { createPdfCalendarFetcher } from "./pdf-calendar.ts";
import { createRssFeedFetcher } from "./rss-feed.ts";
import { createWebPageFetcher } from "./web-page.ts";

// The source adapters of the kinds that need no API key. Quicket and Ticketmaster wait for theirs.
export function createSourceFetchers(deps: {
  languageModel: LanguageModel;
  settings: DiscoverySettings;
  logger: Logger;
}): SourceFetcher[] {
  const http = createHttp({ timeoutSeconds: deps.settings.fetchTimeoutSeconds, userAgent: deps.settings.userAgent });
  const logger = deps.logger.child({ domain: "discovery" });
  return [
    createRssFeedFetcher({ http, logger }),
    createWebPageFetcher({ http, logger }),
    createPdfCalendarFetcher({ http, languageModel: deps.languageModel, logger }),
  ];
}
