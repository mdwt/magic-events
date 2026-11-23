import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  experienceChangesInputSchema,
  experienceChangesResultSchema,
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

  app.post(
    "/experiences/changes",
    {
      config: { action: "experiences.changes" },
      schema: {
        operationId: "getExperienceChanges",
        summary: "Changes since a time",
        description:
          "What changed since a client's last search, among the experiences the same search parameters select: " +
          "new, confirmed, rescheduled, postponed, cancelled, removed or otherwise changed. Give the parameters of " +
          "the search, without its query text, and the time of the last search. Cancelled and removed experiences " +
          "are reported, though search no longer returns them; experiences that are over are not. Each result has " +
          "the change that matters most to a planner and every change since, newest first. The most recent change " +
          "comes first.",
        tags: ["Experiences"],
        body: experienceChangesInputSchema,
        response: { 200: experienceChangesResultSchema, ...errorResponses },
      },
    },
    (request) => catalogue.getChangesSince(request.body),
  );
  return Promise.resolve();
};
