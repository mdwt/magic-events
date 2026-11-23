import type { Catalogue } from "../catalogue/ports.ts";
import { AppError, type ErrorDetail } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  AttributeDefinition,
  DataProcessing,
  DataProcessingRepository,
  SaveSeasonInput,
  Season,
  TagDefinition,
} from "./ports.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Rejects dates that do not exist, such as 2027-02-30, which Date would roll over into March.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Why the attribute's default value does not fit it, or null when it fits.
function defaultValueProblem(input: AttributeDefinition): string | null {
  const value = input.defaultValue;
  if (value === null) return null;
  switch (input.type) {
    case "option":
      if (typeof value !== "string") return "Must be the key of one of the attribute's options.";
      return input.options.some((option) => option.key === value) ? null : `"${value}" is not one of the options.`;
    case "text":
      return typeof value === "string" ? null : "Must be text.";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "Must be a number.";
    case "boolean":
      return typeof value === "boolean" ? null : "Must be true or false.";
    case "date":
      return typeof value === "string" && isIsoDate(value) ? null : "Must be a date as YYYY-MM-DD.";
  }
}

export class DataProcessingService implements DataProcessing {
  readonly #repository: DataProcessingRepository;
  readonly #catalogue: Catalogue;
  readonly #logger: Logger;

  constructor(deps: { repository: DataProcessingRepository; catalogue: Catalogue; logger: Logger }) {
    this.#repository = deps.repository;
    this.#catalogue = deps.catalogue;
    this.#logger = deps.logger.child({ domain: "data-processing" });
  }

  async saveAttribute(input: AttributeDefinition): Promise<AttributeDefinition> {
    const details: ErrorDetail[] = [];
    if (input.type !== "option" && input.options.length > 0) {
      details.push({ path: "options", message: "Only an option attribute has options." });
    }
    const seen = new Set<string>();
    input.options.forEach((option, index) => {
      if (seen.has(option.key)) {
        details.push({ path: `options.${index}.key`, message: `"${option.key}" appears twice.` });
      }
      seen.add(option.key);
    });
    const problem = defaultValueProblem(input);
    if (problem) details.push({ path: "defaultValue", message: problem });
    if (details.length > 0) {
      throw new AppError("invalid_input", `The attribute "${input.key}" is not valid.`, details);
    }

    const saved = await this.#repository.upsertAttribute(input);
    this.#logger.info({ key: saved.key, type: saved.type, options: saved.options.length }, "Attribute saved");
    return saved;
  }

  async saveTag(input: TagDefinition): Promise<TagDefinition> {
    const saved = await this.#repository.upsertTag(input);
    this.#logger.info({ slug: saved.slug }, "Tag saved");
    return saved;
  }

  async saveSeason(input: SaveSeasonInput): Promise<Season> {
    const details: ErrorDetail[] = [];
    input.periods.forEach((period, index) => {
      if (!isIsoDate(period.startDate)) {
        details.push({ path: `periods.${index}.startDate`, message: "Must be a date as YYYY-MM-DD." });
      }
      if (!isIsoDate(period.endDate)) {
        details.push({ path: `periods.${index}.endDate`, message: "Must be a date as YYYY-MM-DD." });
      } else if (isIsoDate(period.startDate) && period.endDate < period.startDate) {
        details.push({ path: `periods.${index}.endDate`, message: "Must not be before the start date." });
      }
    });
    if (details.length > 0) {
      throw new AppError("invalid_input", `The season "${input.slug}" is not valid.`, details);
    }

    // Locations are Catalogue's, so the season's location is found through the Catalogue service.
    const location = await this.#catalogue.getLocation({ slug: input.locationSlug });
    if (!location) {
      throw new AppError("not_found", `No location with the slug "${input.locationSlug}".`, [
        { path: "locationSlug", message: "No such location." },
      ]);
    }

    const saved = await this.#repository.upsertSeason({
      locationId: location.id,
      slug: input.slug,
      name: input.name,
      description: input.description,
      periods: input.periods,
    });
    this.#logger.info(
      { seasonId: saved.id, slug: saved.slug, location: location.slug, periods: saved.periods.length },
      "Season saved",
    );
    return saved;
  }
}
