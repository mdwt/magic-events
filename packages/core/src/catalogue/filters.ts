import type { AttributeDefinition } from "../data-processing/ports.ts";
import type { ErrorDetail } from "../shared/errors.ts";
import type { AttributeFilter } from "./ports.ts";

// A search's attribute filters, checked against the attribute definitions, which Data processing owns. A filter
// that could never match is refused and told what would: a key that is no attribute, an attribute clients cannot
// filter on, a value that is none of its options, or a value of the wrong type.

function list(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

// Why the filter does not fit the attribute, or null when it fits.
function misfit(definition: AttributeDefinition, filter: AttributeFilter): string | null {
  const { key, type } = definition;
  const isRange = typeof filter === "object" && !Array.isArray(filter);

  if (type === "number") {
    return typeof filter === "number" || isRange ? null : `${key} is a number: give a number or a range, { min, max }.`;
  }
  if (isRange) return `${key} is not a number, so it takes no range.`;
  if (type === "boolean") return typeof filter === "boolean" ? null : `${key} is true or false.`;

  // Option, text and date attributes hold text.
  const values = Array.isArray(filter) ? filter : [filter];
  if (values.some((value) => typeof value !== "string")) return `${key} takes text, or a list of texts.`;
  if (type !== "option") return null;
  const options = definition.options.map((option) => option.key);
  const unknown = values.filter((value) => typeof value === "string" && !options.includes(value));
  if (unknown.length === 0) return null;
  return `${key} has no option ${list(unknown.map(String))}. Its options are: ${list(options)}.`;
}

export function checkAttributeFilters(
  filters: Record<string, AttributeFilter>,
  definitions: AttributeDefinition[],
): ErrorDetail[] {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const filterable = list(definitions.filter((definition) => definition.filterable).map((definition) => definition.key));
  const details: ErrorDetail[] = [];
  for (const [key, filter] of Object.entries(filters)) {
    const path = `attributes.${key}`;
    const definition = byKey.get(key);
    if (definition === undefined) {
      details.push({ path, message: `There is no attribute ${key}. The attributes to filter on are: ${filterable}.` });
    } else if (!definition.filterable) {
      details.push({ path, message: `${key} cannot be filtered on. The attributes to filter on are: ${filterable}.` });
    } else {
      const problem = misfit(definition, filter);
      if (problem !== null) details.push({ path, message: problem });
    }
  }
  return details;
}

// How many known slugs a refusal names: the closest to the one given, so the message stays short when there are
// hundreds of tags.
const SUGGESTIONS = 5;

// How many single-letter edits turn one text into the other.
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

// A search's tag filter, checked against the slugs of every tag and season, which Data processing owns. A slug that
// is none of them could never match, so it is refused, with how many there are and the closest few.
export function checkTagFilters(tags: string[], known: string[]): ErrorDetail[] {
  const knownSet = new Set(known);
  return tags.flatMap((slug, index): ErrorDetail[] => {
    if (knownSet.has(slug)) return [];
    // Slugs that hold the one given come first, such as whales and whale-season for whale, then by edit distance.
    const rank = (candidate: string) => [candidate.includes(slug) ? 0 : 1, editDistance(slug, candidate)] as const;
    const closest = [...known]
      .sort((a, b) => {
        const [aHolds, aDistance] = rank(a);
        const [bHolds, bDistance] = rank(b);
        return aHolds - bHolds || aDistance - bDistance || a.localeCompare(b);
      })
      .slice(0, SUGGESTIONS);
    const message =
      known.length === 0
        ? `There is no tag ${slug}. There are no tags to filter on yet.`
        : `There is no tag ${slug}. There are ${String(known.length)} tags and seasons; the closest are: ${list(closest)}.`;
    return [{ path: `tags.${String(index)}`, message }];
  });
}
