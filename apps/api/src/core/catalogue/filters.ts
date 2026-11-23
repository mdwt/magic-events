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
