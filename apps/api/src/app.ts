import type { Db } from "@magic-events/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type pino from "pino";
import { createAuth } from "./adapters/auth/better-auth.ts";
import { createCatalogueRepository } from "./adapters/storage/catalogue-repository.ts";
import { createDataProcessingRepository } from "./adapters/storage/data-processing-repository.ts";
import { createDiscoveryRepository } from "./adapters/storage/discovery-repository.ts";
import { createOrganizationsRepository } from "./adapters/storage/organizations-repository.ts";
import type { Catalogue } from "./core/catalogue/ports.ts";
import { CatalogueService } from "./core/catalogue/service.ts";
import type { DataProcessing } from "./core/data-processing/ports.ts";
import { DataProcessingService } from "./core/data-processing/service.ts";
import type { Discovery } from "./core/discovery/ports.ts";
import { DiscoveryService } from "./core/discovery/service.ts";
import type { Identity } from "./core/identity/ports.ts";
import { IdentityService } from "./core/identity/service.ts";
import type { Organizations } from "./core/organizations/ports.ts";
import { OrganizationsService } from "./core/organizations/service.ts";
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

export function createServices(deps: { settings: Settings; db: Db; logger: Logger }): Services {
  const { settings, db, logger } = deps;
  const catalogue = new CatalogueService({
    repository: createCatalogueRepository(db),
    settings: settings.catalogue,
    logger,
  });
  const organizations = new OrganizationsService({ repository: createOrganizationsRepository(db), logger });
  const identity = new IdentityService({
    auth: createAuth(db, settings.identity),
    organizations,
    settings: settings.identity,
    logger,
  });
  const discovery = new DiscoveryService({
    repository: createDiscoveryRepository(db),
    catalogue,
    settings: settings.discovery,
    logger,
  });
  const dataProcessing = new DataProcessingService({ repository: createDataProcessingRepository(db), catalogue, logger });
  return { catalogue, organizations, identity, discovery, dataProcessing };
}

export async function buildApp(deps: {
  settings: Settings;
  db: Db;
  logger: pino.Logger;
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
