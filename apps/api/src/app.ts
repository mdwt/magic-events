import type { Db } from "@magic-events/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type pino from "pino";
import { createAuth } from "./adapters/auth/better-auth.ts";
import { createEmbeddingModel } from "./adapters/embedding/bedrock.ts";
import { createDomainEvents } from "./adapters/events/node-events.ts";
import { createLanguageModel } from "./adapters/language-model/anthropic.ts";
import { createSourceFetchers } from "./adapters/sources/index.ts";
import { createCatalogueRepository } from "./adapters/storage/catalogue-repository.ts";
import { createDataProcessingRepository } from "./adapters/storage/data-processing-repository.ts";
import { createDiscoveryRepository } from "./adapters/storage/discovery-repository.ts";
import { createOrganizationsRepository } from "./adapters/storage/organizations-repository.ts";
import { createTransactionalDb } from "./adapters/storage/transactions.ts";
import type { Catalogue, EmbeddingModel } from "./core/catalogue/ports.ts";
import { CatalogueService } from "./core/catalogue/service.ts";
import type { DataProcessing } from "./core/data-processing/ports.ts";
import { DataProcessingService } from "./core/data-processing/service.ts";
import type { Discovery, SourceFetcher } from "./core/discovery/ports.ts";
import { DiscoveryService } from "./core/discovery/service.ts";
import type { Identity } from "./core/identity/ports.ts";
import { IdentityService } from "./core/identity/service.ts";
import type { Organizations } from "./core/organizations/ports.ts";
import { OrganizationsService } from "./core/organizations/service.ts";
import type { Clock } from "./core/shared/clock.ts";
import type { DomainEventPublisher, DomainEvents } from "./core/shared/domain-events.ts";
import type { LanguageModel } from "./core/shared/language-model.ts";
import type { Logger } from "./core/shared/logger.ts";
import type { Settings } from "./core/shared/settings.ts";
import { createServer } from "./rest/server.ts";

// The composition root: the only code that imports adapters and services and wires them together.

export interface Services {
  catalogue: Catalogue;
  organizations: Organizations;
  identity: Identity;
  discovery: Discovery;
  dataProcessing: DataProcessing;
}

// What a test, or a run without the real providers, puts in place of an outbound adapter.
export interface Overrides {
  languageModel?: LanguageModel;
  embeddingModel?: EmbeddingModel;
  fetchers?: SourceFetcher[];
  clock?: Clock;
  // A test hands in its own, so it can subscribe and see what was published.
  domainEvents?: DomainEvents;
}

export function createServices(deps: { settings: Settings; db: Db; logger: Logger; overrides?: Overrides }): Services {
  const { settings, logger, overrides = {} } = deps;
  // Every repository is built with the same handle, so work inside transactions.run is saved together.
  const storage = createTransactionalDb(deps.db);
  const { db, transactions } = storage;
  // A domain event goes out once the change it records is saved: when the transaction it was published in commits.
  const domainEvents = overrides.domainEvents ?? createDomainEvents(logger);
  const events: DomainEventPublisher = {
    publish(event) {
      storage.afterCommit(() => {
        domainEvents.publish(event);
      });
    },
  };
  const clock: Clock = overrides.clock ?? (() => new Date());
  const languageModel = overrides.languageModel ?? createLanguageModel(settings.languageModel, logger);
  const embeddings = overrides.embeddingModel ?? createEmbeddingModel(settings.embedding, logger);
  const fetchers =
    overrides.fetchers ?? createSourceFetchers({ languageModel, settings: settings.discovery, logger });

  const catalogue = new CatalogueService({
    repository: createCatalogueRepository(db),
    events,
    settings: settings.catalogue,
    embeddings,
    embeddingSettings: settings.embedding,
    logger,
    clock,
  });
  const organizations = new OrganizationsService({ repository: createOrganizationsRepository(db), logger });
  const identity = new IdentityService({
    auth: createAuth(deps.db, settings.identity),
    organizations,
    settings: settings.identity,
    logger,
  });
  const discovery = new DiscoveryService({
    repository: createDiscoveryRepository(db),
    events,
    catalogue,
    fetchers,
    settings: settings.discovery,
    logger,
    clock,
  });
  const dataProcessing = new DataProcessingService({
    repository: createDataProcessingRepository(db),
    catalogue,
    discovery,
    languageModel,
    transactions,
    settings: settings.processing,
    logger,
    clock,
  });
  return { catalogue, organizations, identity, discovery, dataProcessing };
}

export async function buildApp(deps: {
  settings: Settings;
  db: Db;
  logger: pino.Logger;
  overrides?: Overrides;
}): Promise<{ app: FastifyInstance; services: Services }> {
  const services = createServices(deps);
  const app = await createServer({
    settings: deps.settings.api,
    logger: deps.logger,
    services,
    checkDatabase: async () => {
      await deps.db.execute(sql`select 1`);
    },
  });
  return { app, services };
}
