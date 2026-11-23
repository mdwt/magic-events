import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponses } from "../errors.ts";

// The platform's own endpoints. The health check needs no API key; the OpenAPI document does, like every other
// endpoint.
export const platformRoutes: FastifyPluginAsyncZod<{ checkDatabase: () => Promise<void> }> = (app, { checkDatabase }) => {
  app.get(
    "/health",
    {
      config: { public: true },
      schema: {
        operationId: "getHealth",
        summary: "Health",
        description: "Whether the service is up and can reach its database. Needs no API key.",
        tags: ["Platform"],
        security: [],
        querystring: z.strictObject({}),
        response: {
          200: z.object({ status: z.literal("ok") }).describe("The service is up."),
          400: errorResponses[400],
          429: errorResponses[429],
          500: errorResponses[500],
        },
      },
    },
    async () => {
      await checkDatabase();
      return { status: "ok" as const };
    },
  );

  app.get(
    "/openapi.json",
    {
      config: { action: "openapi.read" },
      schema: {
        operationId: "getOpenApi",
        summary: "OpenAPI document",
        description: "This API's OpenAPI document.",
        tags: ["Platform"],
        querystring: z.strictObject({}),
        response: {
          200: z.record(z.string(), z.unknown()).describe("The OpenAPI 3.1 document."),
          ...errorResponses,
        },
      },
    },
    () => ({ ...app.swagger() }),
  );

  return Promise.resolve();
};
