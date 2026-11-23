import type { Catalogue } from "../catalogue/ports.ts";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { DiscoverySettings } from "../shared/settings.ts";
import type { Discovery, DiscoveryRepository, SaveSourceInput, Source } from "./ports.ts";

// The five source kinds of version 1. Each has one adapter in Discovery and one extractor in Data processing.
export const SOURCE_KINDS = ["quicket", "ticketmaster", "rss_feed", "pdf_calendar", "web_page"] as const;

export class DiscoveryService implements Discovery {
  readonly #repository: DiscoveryRepository;
  readonly #catalogue: Catalogue;
  readonly #settings: DiscoverySettings;
  readonly #logger: Logger;

  constructor(deps: {
    repository: DiscoveryRepository;
    catalogue: Catalogue;
    settings: DiscoverySettings;
    logger: Logger;
  }) {
    this.#repository = deps.repository;
    this.#catalogue = deps.catalogue;
    this.#settings = deps.settings;
    this.#logger = deps.logger.child({ domain: "discovery" });
  }

  async saveSource(input: SaveSourceInput): Promise<Source> {
    if (!(SOURCE_KINDS as readonly string[]).includes(input.kind)) {
      throw new AppError("invalid_input", `Unknown source kind "${input.kind}".`, [
        { path: "kind", message: `Must be one of ${SOURCE_KINDS.join(", ")}.` },
      ]);
    }

    // Locations are Catalogue's, so the source's location is found through the Catalogue service.
    const location = await this.#catalogue.getLocation({ slug: input.locationSlug });
    if (!location) {
      throw new AppError("not_found", `No location with the slug "${input.locationSlug}".`, [
        { path: "locationSlug", message: "No such location." },
      ]);
    }

    const source = await this.#repository.upsertSource({
      name: input.name,
      kind: input.kind,
      locationId: location.id,
      settings: input.settings ?? {},
      credentialsSetting: input.credentialsSetting ?? null,
      priority: input.priority ?? 0,
      fetchIntervalHours: input.fetchIntervalHours ?? this.#settings.defaultFetchIntervalHours,
      missedRunsBeforeRemoval: input.missedRunsBeforeRemoval ?? this.#settings.defaultMissedRunsBeforeRemoval,
      maxProcessingAttempts: input.maxProcessingAttempts ?? this.#settings.defaultMaxProcessingAttempts,
      active: input.active ?? true,
    });

    this.#logger.info(
      { sourceId: source.id, name: source.name, kind: source.kind, location: location.slug },
      "Source saved",
    );
    return source;
  }
}
