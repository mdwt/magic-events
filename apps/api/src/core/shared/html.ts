import { load } from "cheerio";

// The text a person sees on a web page: no scripts, styles, markup or hidden parts, one block per line.
// Discovery takes a page's fingerprint from it, so a page whose markup changes on every fetch is not seen as
// changed, and Data processing hands it to the language model.
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
