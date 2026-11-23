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

// A latitude and a longitude in decimal degrees, as a map link carries them, with the comma written or encoded.
const COORDINATES = /-?\d{1,2}\.\d+(,|%2C)\s*-?\d{1,3}\.\d+/i;

// The page's links to a map that carry coordinates, such as a "Directions" link to maps?q=-34.42,19.23. Their
// addresses are not visible text, and they are often the only place a page states where its venue is.
export function mapLinks(html: string): string[] {
  const $ = load(html);
  const links = $("a[href]")
    .toArray()
    .map((element) => ($(element).attr("href") ?? "").trim())
    .filter((href) => /map/i.test(href) && COORDINATES.test(href));
  return [...new Set(links)];
}

// Everything the page says: its visible text, then its structured data and its map links.
export function pageContent(html: string): string {
  const text = visibleText(html);
  const data = structuredData(html);
  const maps = mapLinks(html);
  const parts = [text];
  if (data.length > 0) parts.push("Structured data (JSON-LD):", ...data);
  if (maps.length > 0) parts.push("Map links:", ...maps);
  return parts.filter((part) => part.length > 0).join("\n");
}
