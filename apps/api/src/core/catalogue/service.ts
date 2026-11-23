import { AppError, type ErrorDetail } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { CatalogueSettings } from "../shared/settings.ts";
import {
  SEARCHABLE_STATUSES,
  type Catalogue,
  type CatalogueRepository,
  type ExperienceSearchQuery,
  type Location,
  type SaveLocationInput,
  type SearchExperiencesInput,
  type SearchExperiencesResult,
} from "./ports.ts";

export class CatalogueService implements Catalogue {
  readonly #repository: CatalogueRepository;
  readonly #settings: CatalogueSettings;
  readonly #logger: Logger;

  constructor(deps: { repository: CatalogueRepository; settings: CatalogueSettings; logger: Logger }) {
    this.#repository = deps.repository;
    this.#settings = deps.settings;
    this.#logger = deps.logger;
  }

  async searchExperiences(input: SearchExperiencesInput): Promise<SearchExperiencesResult> {
    const query = this.#resolve(input);
    this.#logger.debug({ query }, "Searching experiences");

    const started = performance.now();
    const { items, total } = await this.#repository.searchExperiences(query);
    this.#logger.debug(
      { count: items.length, total, durationMs: Math.round(performance.now() - started) },
      "Searched experiences",
    );

    return {
      items: items.map((item) => ({ ...item, bookable: item.status === "confirmed" && item.booking === "open" })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  saveLocation(input: SaveLocationInput): Promise<Location> {
    return this.#repository.upsertLocation(input);
  }

  getLocation(by: { id: string } | { slug: string }): Promise<Location | null> {
    return this.#repository.findLocation(by);
  }

  // Applies the defaults and checks the rules, so the repository runs a query that is already sound.
  #resolve(input: SearchExperiencesInput): ExperienceSearchQuery {
    const details: ErrorDetail[] = [];
    const radiusKm = input.radiusKm ?? this.#settings.searchDefaultRadiusKm;
    if (radiusKm > this.#settings.searchMaxRadiusKm) {
      details.push({ path: "radiusKm", message: `radiusKm must be at most ${this.#settings.searchMaxRadiusKm} km.` });
    }
    if (input.to < input.from) {
      details.push({ path: "to", message: "to must not be before from." });
    }
    const attributes = input.attributes ?? {};
    for (const [key, filter] of Object.entries(attributes)) {
      if (typeof filter !== "object" || Array.isArray(filter)) continue;
      if (filter.min === undefined && filter.max === undefined) {
        details.push({ path: `attributes.${key}`, message: `The range on ${key} needs min or max.` });
      } else if (filter.min !== undefined && filter.max !== undefined && filter.min > filter.max) {
        details.push({ path: `attributes.${key}.min`, message: `The range on ${key} has min above max.` });
      }
    }
    if (details.length > 0) {
      this.#logger.warn({ details }, "Search refused");
      throw new AppError("invalid_input", details.map((detail) => detail.message).join(" "), details);
    }

    // Bookable means Confirmed with booking Open. Status values that leave out Confirmed then match nothing.
    const statuses = input.status ?? [...SEARCHABLE_STATUSES];
    return {
      near: input.near,
      radiusKm,
      from: input.from,
      to: input.to,
      statuses: input.bookable === true ? statuses.filter((status) => status === "confirmed") : statuses,
      ...(input.bookable === true ? { bookings: ["open" as const] } : {}),
      attributes,
      tags: input.tags ?? [],
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit,
      offset: input.offset,
    };
  }
}
