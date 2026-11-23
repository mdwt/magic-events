import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  credentialListSchema,
  credentialParamsSchema,
  credentialSummarySchema,
  issueCredentialInputSchema,
  issuedCredentialSchema,
  userIdParamsSchema,
  type Identity,
} from "@magic-events/core/identity/ports.ts";
import { errorResponses, notFoundResponse } from "../errors.ts";

// Issuing, listing and revoking a user's API keys. A system admin's alone: a client is refused before anything here
// runs. The key itself is in the answer of the call that issues it, and nowhere else.

const TAGS = ["Credentials"];

export const identityRoutes: FastifyPluginAsyncZod<{ identity: Identity }> = (app, { identity }) => {
  app.post(
    "/users/:userId/credentials",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "createCredential",
        summary: "Issue an API key",
        description:
          "Issues an API key for a user, for the REST API and MCP alike, used by a person or by an AI agent acting " +
          "for them. The key is in this answer only: it is stored as a hash and cannot be read again. For system " +
          "admins only.",
        tags: TAGS,
        params: userIdParamsSchema,
        body: issueCredentialInputSchema,
        response: {
          201: issuedCredentialSchema.describe("The credential, with its API key."),
          ...errorResponses,
          ...notFoundResponse,
        },
      },
    },
    async (request, reply) => {
      const issued = await identity.issueCredential({ userId: request.params.userId, ...request.body });
      reply.code(201);
      return issued;
    },
  );

  app.get(
    "/users/:userId/credentials",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "listCredentials",
        summary: "List a user's API keys",
        description:
          "A user's credentials, with their names, who uses them and whether they are enabled. Never the keys " +
          "themselves. For system admins only.",
        tags: TAGS,
        params: userIdParamsSchema,
        querystring: z.strictObject({}),
        response: {
          200: credentialListSchema.describe("The user's credentials."),
          ...errorResponses,
          ...notFoundResponse,
        },
      },
    },
    async (request) => ({ items: await identity.listCredentials(request.params.userId) }),
  );

  app.delete(
    "/users/:userId/credentials/:credentialId",
    {
      config: { action: "tenants.manage" },
      schema: {
        operationId: "revokeCredential",
        summary: "Revoke an API key",
        description:
          "Disables one of a user's API keys: every call with it is refused from then on. The user's other keys " +
          "keep working. For system admins only.",
        tags: TAGS,
        params: credentialParamsSchema,
        querystring: z.strictObject({}),
        response: {
          200: credentialSummarySchema.describe("The credential, now disabled."),
          ...errorResponses,
          ...notFoundResponse,
        },
      },
    },
    (request) => identity.revokeCredential(request.params.userId, request.params.credentialId),
  );

  return Promise.resolve();
};
