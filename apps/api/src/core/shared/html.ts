import { load } from "cheerio";

// What a web page says, as text. Discovery takes a page's fingerprint from it, so a page whose markup changes on
// every fetch is not seen as changed, and Data processing hands it to the language model.

// The text a person sees on the page: no scripts, styles, markup or hidden parts, one block per line.
export function visibleText(html: string): string {
  const $ = load(html);
  $("script, style, noscript, template, svg, iframe, head, [hidden], [aria-hidden='true']").remove();
  // A line break after each block, so words of neighbouring blocks do not run together.
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, header, footer, td, th, dt, dd, blockquote").append("\n");
  return $.root()
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

// The page's structured data: its JSON-LD blocks, each on one line. Many listing sites put their events here,
// and some, such as Quicket's search pages, put them nowhere else.
export function structuredData(html: string): string[] {
  const $ = load(html);
  return $('script[type="application/ld+json"]')
    .toArray()
    .map((element) => $(element).text().trim())
    .filter((text) => text.length > 0)
    .map((text) => {
      try {
        return JSON.stringify(JSON.parse(text));
      } catch {
        // Not valid JSON: kept as written, with its whitespace collapsed.
        return text.replace(/\s+/g, " ");
      }
    });
}

// Everything the page says: its visible text, then its structured data.
export function pageContent(html: string): string {
  const text = visibleText(html);
  const data = structuredData(html);
  if (data.length === 0) return text;
  return [text, "Structured data (JSON-LD):", ...data].filter((part) => part.length > 0).join("\n");
}
