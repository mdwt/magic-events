import { z } from "zod";
import type { AttributeValue } from "../catalogue/ports.ts";
import { isIsoDate, overlaps } from "./dates.ts";
import { type ExtractedExperience, sessionEnd } from "./extract.ts";
import { CLASSIFICATION_INSTRUCTIONS_INTRODUCTION } from "./instructions.ts";
import type { AttributeDefinition, Season, TagDefinition } from "./ports.ts";

// Classification: one extracted experience is given its attribute values, tags, seasons and profile. The model
// picks from the definitions; the code checks what it picked against them.

export interface Definitions {
  attributes: AttributeDefinition[];
  tags: TagDefinition[];
}

// Attributes are rows, so their keys are not known to the schema. Each value is text, read by the attribute's type.
export const classificationAnswerSchema = z.object({
  attributes: z.array(
    z.object({
      key: z.string().describe("The attribute's key, exactly as defined."),
      values: z.array(z.string()).describe("Option keys, or the value as text."),
    }),
  ),
  tags: z.array(z.string()).describe("Tag slugs, exactly as defined."),
  profile: z.string().describe("Two to four sentences in English."),
});
export type ClassificationAnswer = z.infer<typeof classificationAnswerSchema>;

const TYPE_NAMES: Record<AttributeDefinition["type"], string> = {
  option: "option",
  text: "text",
  number: "number",
  boolean: "true or false",
  date: "date",
};

// The instructions with the definitions written out. They change only when a definition does, so calls that
// share them can be served from the model's cache.
export function classificationInstructions(definitions: Definitions): string {
  const lines = [CLASSIFICATION_INSTRUCTIONS_INTRODUCTION, "", "Attributes:"];
  for (const attribute of definitions.attributes) {
    const takes = attribute.type === "option" ? (attribute.multiple ? ", several values" : ", one value") : "";
    lines.push("", `${attribute.key} (${attribute.name}; ${TYPE_NAMES[attribute.type]}${takes}): ${attribute.description}`);
    for (const option of attribute.options) {
      lines.push(`- ${option.key} (${option.name}): ${option.description}`);
    }
  }
  lines.push("", "Tags:");
  for (const tag of definitions.tags) lines.push(`- ${tag.slug} (${tag.name}): ${tag.description}`);
  return lines.join("\n");
}

// What the model is shown of the experience: what a source says about it, and nothing derived.
export function classificationText(experience: ExtractedExperience): string {
  const venue = [experience.venue?.name, experience.venue?.address, experience.venue?.city].filter(
    (part) => part !== undefined,
  );
  return [
    `Title: ${experience.title}`,
    `Summary: ${experience.summary ?? ""}`,
    `Description: ${experience.description ?? ""}`,
    `Venue: ${venue.join(", ")}`,
    `The source's labels: ${experience.hints.join(", ")}`,
  ].join("\n");
}

export interface UndefinedValueFound {
  kind: "attribute" | "option" | "tag";
  // The value as returned. An option is written as attribute:option.
  value: string;
}

export interface Classification {
  attributes: Record<string, AttributeValue[]>;
  tags: string[];
  profile: string | undefined;
  undefinedValues: UndefinedValueFound[];
  // Values that are defined but do not fit, such as text given for a number. Left off and logged.
  misfits: string[];
}

function normal(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

// A definition found by its key, or by its name, whatever the case: the model may echo either.
function find<T>(items: T[], value: string, keys: (item: T) => string[]): T | undefined {
  const wanted = normal(value);
  return items.find((item) => keys(item).some((key) => normal(key) === wanted));
}

function readValue(attribute: AttributeDefinition, raw: string): AttributeValue | null {
  const value = raw.trim();
  switch (attribute.type) {
    case "option":
      return find(attribute.options, value, (option) => [option.key, option.name])?.key ?? null;
    case "text":
      return value === "" ? null : value;
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
      return Number(value);
    }
    case "boolean":
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
      return null;
    case "date":
      return isIsoDate(value) ? value : null;
  }
}

// The answer checked against the definitions: what is not defined is kept off and reported, a value must fit its
// attribute's type, a single-valued attribute gets one value, and an attribute with no value gets its default.
export function checkClassification(answer: ClassificationAnswer, definitions: Definitions): Classification {
  const attributes: Record<string, AttributeValue[]> = {};
  const undefinedValues: UndefinedValueFound[] = [];
  const misfits: string[] = [];

  for (const given of answer.attributes) {
    const attribute = find(definitions.attributes, given.key, (item) => [item.key, item.name]);
    if (attribute === undefined) {
      undefinedValues.push({ kind: "attribute", value: given.key.trim() });
      continue;
    }
    const values: AttributeValue[] = attribute.key in attributes ? (attributes[attribute.key] ?? []) : [];
    for (const raw of given.values) {
      const value = readValue(attribute, raw);
      if (value === null) {
        if (attribute.type === "option" && raw.trim() !== "") {
          undefinedValues.push({ kind: "option", value: `${attribute.key}:${raw.trim()}` });
        } else {
          misfits.push(`${attribute.key}: ${raw}`);
        }
        continue;
      }
      if (!values.includes(value)) values.push(value);
    }
    if (!attribute.multiple && values.length > 1) {
      misfits.push(`${attribute.key}: ${values.slice(1).join(", ")} (one value only)`);
      values.splice(1);
    }
    if (values.length > 0) attributes[attribute.key] = values;
  }

  for (const attribute of definitions.attributes) {
    if (!(attribute.key in attributes) && attribute.defaultValue !== null) {
      attributes[attribute.key] = [attribute.defaultValue];
    }
  }

  const tags: string[] = [];
  for (const given of answer.tags) {
    const tag = find(definitions.tags, given, (item) => [item.slug, item.name]);
    if (tag === undefined) {
      if (given.trim() !== "") undefinedValues.push({ kind: "tag", value: given.trim() });
      continue;
    }
    if (!tags.includes(tag.slug)) tags.push(tag.slug);
  }

  const profile = answer.profile.trim();
  return { attributes, tags, profile: profile === "" ? undefined : profile, undefinedValues, misfits };
}

// The seasons of the location that the experience's dates fall inside, as their slugs. A season applies when any
// of its periods overlaps any session or, for a recurring experience, the recurrence's span up to the horizon.
export function seasonsOf(experience: ExtractedExperience, seasons: Season[], horizonEnd: string): string[] {
  const spans = experience.sessions.map((session) => ({ start: session.start, end: sessionEnd(session) }));
  const recurrence = experience.recurrence;
  if (recurrence) {
    const end = recurrence.end === undefined || recurrence.end > horizonEnd ? horizonEnd : recurrence.end;
    if (end >= recurrence.start) spans.push({ start: recurrence.start, end });
  }
  return seasons
    .filter((season) =>
      season.periods.some((period) =>
        spans.some((span) => overlaps(span, { start: period.startDate, end: period.endDate })),
      ),
    )
    .map((season) => season.slug);
}

// The season an extracted experience is, when it is one: its dates are only months or years and are exactly one
// period of a season of its location, such as "Southern right whales in Walker Bay, June to November", which is
// whale season. A season is predefined and becomes a tag; it is never an experience.
export function seasonItIs(experience: ExtractedExperience, seasons: Season[]): Season | undefined {
  const { sessions } = experience;
  if (experience.recurrence !== undefined || sessions.length === 0) return undefined;
  if (sessions.some((session) => session.precision === "day")) return undefined;
  const start = sessions.map((session) => session.start).reduce((a, b) => (b < a ? b : a));
  const end = sessions.map(sessionEnd).reduce((a, b) => (b > a ? b : a));
  return seasons.find((season) =>
    season.periods.some((period) => period.startDate === start && period.endDate === end),
  );
}
