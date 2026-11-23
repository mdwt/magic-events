import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  searchExperiencesInputSchema,
  searchExperiencesResultSchema,
  type Catalogue,
} from "../../core/catalogue/ports.ts";
import { errorResponses } from "../errors.ts";

export const catalogueRoutes: FastifyPluginAsyncZod<{ catalogue: Catalogue }> = (app, { catalogue }) => {
  app.post(
    "/experiences/search",
    {
      config: { action: "experiences.search" },
      schema: {
        operationId: "searchExperiences",
        summary: "Search experiences",
        description:
          "Experiences near a point that are on during the dates given: festivals, concerts, matches, markets, " +
          "shows and exhibitions. Dates match an experience's sessions, so an experience is returned only when it " +
          "is on inside the range, and each result carries the sessions that fall inside it. The filters decide " +
          "what is returned; the query text only orders the results.",
        tags: ["Experiences"],
        body: searchExperiencesInputSchema,
        response: { 200: searchExperiencesResultSchema, ...errorResponses },
      },
    },
    (request) => catalogue.searchExperiences(request.body),
  );
  return Promise.resolve();
};
