import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { FetchedListing, SourceFetcher } from "../../discovery/ports.ts";
import type { Logger } from "../../shared/logger.ts";
import { HttpStatusError, MAX_PAGE_BYTES, parseSettings, textOf, type Http } from "./http.ts";

// The RSS feed adapter: one listing per item of an RSS 2.0 or Atom feed, the item's own XML exactly as in the feed.
// A feed holds only the latest posts, so a run is never complete: a post that leaves the feed is not gone.

const settingsSchema = z.strictObject({
  feedUrl: z.url(),
  // How many pages of the feed to read, through WordPress's ?paged=N. The first page alone by default.
  maxPages: z.number().int().min(1).max(100).optional(),
});

type XmlNode = Record<string | symbol, unknown>;

// fast-xml-parser types its metadata key as the Symbol wrapper object, but it is a plain symbol.
const METADATA = XMLParser.getMetaDataSymbol() as unknown as symbol;

const parser = new XMLParser({
  captureMetaData: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // GUIDs and links are kept as written, never turned into numbers.
  parseTagValue: false,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

// An element's text, whether it was parsed as a string or as a node with attributes.
function text(value: unknown): string | undefined {
  const raw = isNode(value) ? value["#text"] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// The item's own XML: the part of the feed from its opening tag to its closing tag.
function sourceOf(xml: string, node: XmlNode): string {
  const metadata = node[METADATA];
  if (!isNode(metadata) || typeof metadata.startIndex !== "number" || typeof metadata.endIndex !== "number") {
    throw new Error("The XML parser gave no position for a feed item");
  }
  return xml.slice(metadata.startIndex, metadata.endIndex);
}

interface FeedItem {
  id: string | undefined;
  link: string | undefined;
  xml: string;
}

// RSS 2.0's items or Atom's entries. Anything else is not a feed this adapter reads.
export function feedItems(xml: string): FeedItem[] {
  const parsed: unknown = parser.parse(xml);
  if (!isNode(parsed)) throw new Error("The feed is not XML");

  const rss = parsed.rss;
  if (isNode(rss)) {
    const channel = rss.channel;
    if (!isNode(channel)) throw new Error("The RSS feed has no channel");
    return nodes(channel.item).map((item) => {
      const link = Array.isArray(item.link) ? item.link.map(text).find((one) => one !== undefined) : text(item.link);
      return { id: text(item.guid), link, xml: sourceOf(xml, item) };
    });
  }

  const feed = parsed.feed;
  if (isNode(feed)) {
    return nodes(feed.entry).map((entry) => {
      // The entry's own page is its alternate link, which is also the link with no rel.
      const links = nodes(entry.link);
      const alternate = links.find((one) => one["@_rel"] === undefined || one["@_rel"] === "alternate");
      const href = alternate?.["@_href"];
      return { id: text(entry.id), link: typeof href === "string" ? href : undefined, xml: sourceOf(xml, entry) };
    });
  }

  throw new Error("The address answered with XML that is neither an RSS 2.0 nor an Atom feed");
}

export function createRssFeedFetcher(deps: { http: Http; logger: Logger }): SourceFetcher {
  const logger = deps.logger.child({ adapter: "rss_feed" });
  return {
    kind: "rss_feed",

    async fetch(input) {
      const settings = parseSettings("rss_feed", settingsSchema, input.settings);
      const maxPages = settings.maxPages ?? 1;
      const listings = new Map<string, FetchedListing>();

      for (let page = 1; page <= maxPages; page += 1) {
        const address = new URL(settings.feedUrl);
        if (page > 1) address.searchParams.set("paged", String(page));

        let response;
        try {
          response = await deps.http.get(address.href, {
            accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
            maxBytes: MAX_PAGE_BYTES,
          });
        } catch (error) {
          // A WordPress feed answers not found for a page past its last.
          if (page > 1 && error instanceof HttpStatusError && error.status === 404) break;
          throw error;
        }

        const items = feedItems(textOf(response));
        let added = 0;
        for (const item of items) {
          const sourceListingId = item.id ?? item.link;
          if (sourceListingId === undefined) {
            logger.warn({ page, feedUrl: settings.feedUrl }, "A feed item has no GUID and no link, so it is left out");
            continue;
          }
          if (listings.has(sourceListingId)) continue;
          listings.set(sourceListingId, {
            sourceListingId,
            ...(item.link === undefined ? {} : { url: item.link }),
            contentType: "application/xml",
            content: item.xml,
          });
          added += 1;
        }
        logger.debug({ page, items: items.length, added }, "Read a page of the feed");
        // An empty page is the end of the feed, and a page with nothing new means the site ignores ?paged=N.
        if (added === 0) break;
      }

      return { listings: [...listings.values()], complete: false, syncState: {} };
    },
  };
}
