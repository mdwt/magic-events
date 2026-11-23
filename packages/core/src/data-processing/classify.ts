import rrule from "rrule";
import { z } from "zod";
import type { AttributeValue } from "../catalogue/ports.ts";
import { isIsoDate } from "./dates.ts";
import { type ExtractedExperience, type ExtractedRecurrence, sessionEnd } from "./extract.ts";
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

// What the model is shown of the experience: what a source says about it, and nothing derived. The price and the
// venue are there because the tier is decided from them, with the description.
export function classificationText(experience: ExtractedExperience): string {
  const venue = [experience.venue?.name, experience.venue?.address, experience.venue?.city].filter(
    (part) => part !== undefined,
  );
  return [
    `Title: ${experience.title}`,
    `Summary: ${experience.summary ?? ""}`,
    `Description: ${experience.description ?? ""}`,
    `Venue: ${venue.join(", ")}`,
    `Price: ${priceText(experience.price)}`,
    `The source's labels: ${experience.hints.join(", ")}`,
    `Age limit the source states: ${experience.minimumAge === undefined ? "none" : String(experience.minimumAge)}`,
  ].join("\n");
}

// The price as a source gives it: a range, free when it is 0 and 0, or not stated when it has none.
function priceText(price: ExtractedExperience["price"]): string {
  const { min, max, currency } = price ?? {};
  if (min === undefined && max === undefined) return "not stated";
  if ((min ?? 0) === 0 && (max ?? 0) === 0) return "free";
  const amount = (value: number) => (currency === undefined ? String(value) : `${currency} ${String(value)}`);
  if (min === undefined) return `up to ${amount(max ?? 0)}`;
  if (max === undefined || max === min) return amount(min);
  return `${amount(min)} to ${amount(max)}`;
}

// The attributes a stated age limit decides, whatever the model chose: the minimum age is the limit, and an
// experience with a limit of 18 or more is for adults. Each applies only when its definition is there to take it.
const MINIMUM_AGE = "minimum_age";
const AUDIENCE = "audience";
const ADULTS = "adults";

export function withStatedAge(
  attributes: Record<string, AttributeValue[]>,
  minimumAge: number | undefined,
  definitions: Definitions,
): Record<string, AttributeValue[]> {
  if (minimumAge === undefined) return attributes;
  const definition = (key: string) => definitions.attributes.find((attribute) => attribute.key === key);
  const result = { ...attributes };
  if (definition(MINIMUM_AGE)?.type === "number") result[MINIMUM_AGE] = [minimumAge];
  const audience = definition(AUDIENCE);
  if (minimumAge >= 18 && audience?.options.some((option) => option.key === ADULTS)) result[AUDIENCE] = [ADULTS];
  return result;
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

// The days a recurrence gives from its first date to `end`, both included, less the skipped ones.
function recurrenceDays(recurrence: ExtractedRecurrence, end: string): string[] {
  if (end < recurrence.start) return [];
  const rule = rrule.rrulestr(`RRULE:${recurrence.rule}`, { dtstart: new Date(`${recurrence.start}T00:00:00Z`) });
  const skipped = new Set(recurrence.skipped ?? []);
  const days = rule
    .between(new Date(`${recurrence.start}T00:00:00Z`), new Date(`${end}T23:59:59.999Z`), true)
    .map((date) => date.toISOString().slice(0, 10));
  return [...new Set(days)].filter((day) => !skipped.has(day));
}

// The seasons of the location that all of the experience's dates fall inside, as their slugs. Each session must be
// inside one of the season's periods, the whole month or year for month or year precision, and so must every day
// its recurrence gives up to its last date, and no further than the horizon. An open-ended one has no last date, so
// its days are counted up to the horizon or the end of the season's last period, whichever is earlier, since a
// season's later years are not rows yet. So a market every Saturday of the year is in no season, and whale watching
// every day from June to November is in whale season.
export function seasonsOf(experience: ExtractedExperience, seasons: Season[], horizonEnd: string): string[] {
  const spans = experience.sessions.map((session) => ({ start: session.start, end: sessionEnd(session) }));
  const recurrence = experience.recurrence;
  return seasons
    .filter((season) => {
      const inside = (span: { start: string; end: string }) =>
        season.periods.some((period) => period.startDate <= span.start && span.end <= period.endDate);
      const lastPeriodEnd = season.periods.reduce((last, period) => (period.endDate > last ? period.endDate : last), "");
      const days = recurrence
        ? recurrenceDays(recurrence, earlier(recurrence.end ?? lastPeriodEnd, horizonEnd))
        : [];
      if (spans.length === 0 && days.length === 0) return false;
      return spans.every(inside) && days.every((day) => inside({ start: day, end: day }));
    })
    .map((season) => season.slug);
}

function earlier(a: string, b: string): string {
  return b < a ? b : a;
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
