import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  addTenantUserInputSchema,
  createTenantInputSchema,
  tenantListSchema,
  tenantSchema,
  tenantSlugParamsSchema,
  tenantWithUsersSchema,
  updateTenantInputSchema,
  userSchema,
  type Organizations,
} from "@magic-events/core/organizations/ports.ts";
import { bodyErrorResponses, conflictResponse, errorResponses, notFoundResponse } from "../errors.ts";

// Onboarding tenants and their users. A system admin's alone: a client is refused before anything here runs.

const TAGS = ["Tenants"];

export const organizationsRoutes: FastifyPluginAsyncZod<{ organizations: Organizations }> = (app, { organizations }) => {
  app.post(
    "/tenants",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "createTenant",
        summary: "Create a tenant",
        description:
          "Creates a tenant, a travel agency or a travel app, as active, with its configuration. The slug is the " +
          "tenant's lasting name in addresses and must not be taken. For system admins only.",
        tags: TAGS,
        body: createTenantInputSchema,
        response: {
          201: tenantSchema.describe("The tenant, created."),
          ...errorResponses,
          ...bodyErrorResponses,
          ...conflictResponse,
        },
      },
    },
    async (request, reply) => {
      const tenant = await organizations.createTenant(request.body);
      reply.code(201);
      return tenant;
    },
  );

  app.get(
    "/tenants",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "listTenants",
        summary: "List tenants",
        description: "Every tenant, by name, with its kind, status and configuration. For system admins only.",
        tags: TAGS,
        querystring: z.strictObject({}),
        response: { 200: tenantListSchema.describe("Every tenant."), ...errorResponses },
      },
    },
    async () => ({ items: await organizations.listTenants() }),
  );

  app.get(
    "/tenants/:slug",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "getTenant",
        summary: "Get a tenant",
        description: "One tenant, with its users. For system admins only.",
        tags: TAGS,
        params: tenantSlugParamsSchema,
        querystring: z.strictObject({}),
        response: {
          200: tenantWithUsersSchema.describe("The tenant and its users."),
          ...errorResponses,
          ...notFoundResponse,
        },
      },
    },
    async (request) => {
      const tenant = await organizations.getTenantBySlug(request.params.slug);
      return { ...tenant, users: await organizations.listUsers(tenant.id) };
    },
  );

  app.patch(
    "/tenants/:slug",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "updateTenant",
        summary: "Change a tenant",
        description:
          "Changes a tenant's name, status or configuration; what is left out stays as it is. Setting the status to " +
          "suspended turns the tenant's access off: its users are refused until it is active again. For system " +
          "admins only.",
        tags: TAGS,
        params: tenantSlugParamsSchema,
        body: updateTenantInputSchema,
        response: {
          200: tenantSchema.describe("The tenant, changed."),
          ...errorResponses,
          ...bodyErrorResponses,
          ...notFoundResponse,
        },
      },
    },
    (request) => organizations.updateTenant(request.params.slug, request.body),
  );

  app.post(
    "/tenants/:slug/users",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "addTenantUser",
        summary: "Add a user to a tenant",
        description:
          "Adds a person to a tenant with the client role. The email address must not belong to another user. " +
          "Issue the user's API keys next, with createCredential. For system admins only.",
        tags: TAGS,
        params: tenantSlugParamsSchema,
        body: addTenantUserInputSchema,
        response: {
          201: userSchema.describe("The user, created."),
          ...errorResponses,
          ...bodyErrorResponses,
          ...notFoundResponse,
          ...conflictResponse,
        },
      },
    },
    async (request, reply) => {
      const user = await organizations.createUser({ ...request.body, role: "client", tenantSlug: request.params.slug });
      reply.code(201);
      return user;
    },
  );

  return Promise.resolve();
};
