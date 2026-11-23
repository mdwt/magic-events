import { load } from "cheerio";
import { z } from "zod";
import type { SourceFetcher } from "../../core/discovery/ports.ts";
import type { LanguageModel } from "../../core/shared/language-model.ts";
import type { Logger } from "../../core/shared/logger.ts";
import { MAX_FILE_BYTES, MAX_PAGE_BYTES, parseSettings, textOf, type Http } from "./http.ts";

// The PDF calendar adapter: one listing, the current file of one calendar. The file's name changes with each
// reissue, so the language model is shown the links on the calendar page and picks the current one.

const settingsSchema = z.strictObject({
  pageUrl: z.url(),
  // The calendar's name as the page shows it, such as "Annual events". It is also the listing's ID.
  calendarName: z.string().trim().min(1),
});

const INSTRUCTIONS = [
  "You are given the links on a web page that publishes event calendars as PDF files, the name of one calendar,",
  "and today's date. Each calendar is reissued from time to time under a new file name, so the links are the only",
  "guide to which file is current.",
  "Pick the link to the current file of the named calendar: the issue for the period that includes today, or",
  "else the next one ahead, and the newest issue when there are several for the same period. A calendar named",
  "for a month, such as November Events, means the file for that kind of calendar that covers the current month.",
  "Answer with the link's address exactly as it is written in the list. When no link is a file of that calendar,",
  "answer null.",
].join(" ");

const answerSchema = z.object({
  url: z.string().nullable().describe("The address of the current file, exactly as listed, or null when there is none."),
});

interface PageLink {
  url: string;
  text: string;
}

// Every link on the page, by its absolute address, with the texts it is shown with.
export function pageLinks(html: string, pageUrl: string): PageLink[] {
  const $ = load(html);
  const links = new Map<string, Set<string>>();
  for (const element of $("a[href]").toArray()) {
    const href = $(element).attr("href");
    if (href === undefined) continue;
    let address: URL;
    try {
      address = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (address.protocol !== "http:" && address.protocol !== "https:") continue;
    address.hash = "";
    const label = ($(element).text() || $(element).attr("title") || "").replace(/\s+/g, " ").trim();
    const texts = links.get(address.href) ?? new Set<string>();
    if (label !== "") texts.add(label);
    links.set(address.href, texts);
  }
  return [...links].map(([url, texts]) => ({ url, text: [...texts].join(" / ") }));
}

export function createPdfCalendarFetcher(deps: { http: Http; languageModel: LanguageModel; logger: Logger }): SourceFetcher {
  const logger = deps.logger.child({ adapter: "pdf_calendar" });
  return {
    kind: "pdf_calendar",

    async fetch(input) {
      const settings = parseSettings("pdf_calendar", settingsSchema, input.settings);

      const page = await deps.http.get(settings.pageUrl, {
        accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.8",
        maxBytes: MAX_PAGE_BYTES,
      });
      const links = pageLinks(textOf(page), page.url);
      if (links.length === 0) throw new Error(`The calendar page ${settings.pageUrl} has no links`);

      const answer = await deps.languageModel.ask({
        instructions: INSTRUCTIONS,
        text: [
          `Calendar: ${settings.calendarName}`,
          `Today: ${input.window.from}`,
          `Links on ${page.url}:`,
          ...links.map((link) => `- ${link.text === "" ? "(no text)" : link.text}: ${link.url}`),
        ].join("\n"),
        schema: answerSchema,
      });
      if (answer.url === null) {
        throw new Error(`The language model found no file of the calendar "${settings.calendarName}" on ${page.url}`);
      }
      const chosen = links.find((link) => link.url === answer.url);
      if (!chosen) {
        throw new Error(`The language model named ${answer.url}, which is not a link on ${page.url}`);
      }
      logger.debug({ calendar: settings.calendarName, url: chosen.url, links: links.length }, "Picked the current file");

      const file = await deps.http.get(chosen.url, { accept: "application/pdf", maxBytes: MAX_FILE_BYTES });
      if (Buffer.from(file.body.subarray(0, 5)).toString("latin1") !== "%PDF-") {
        throw new Error(`${chosen.url}, picked as the current file of "${settings.calendarName}", is not a PDF`);
      }

      return {
        listings: [
          {
            sourceListingId: settings.calendarName,
            url: chosen.url,
            contentType: "application/pdf",
            content: Buffer.from(file.body).toString("base64"),
          },
        ],
        complete: true,
        syncState: {},
      };
    },
  };
}
