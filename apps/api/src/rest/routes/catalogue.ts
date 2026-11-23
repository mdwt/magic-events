import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  experienceChangesInputSchema,
  experienceChangesResultSchema,
  searchExperiencesInputSchema,
  searchExperiencesResultSchema,
  type Catalogue,
} from "@magic-events/core/catalogue/ports.ts";
import { bodyErrorResponses, errorResponses } from "../errors.ts";

export const catalogueRoutes: FastifyPluginAsyncZod<{ catalogue: Catalogue }> = (app, { catalogue }) => {
  app.post(
    "/experiences/search",
    {
      config: { action: "experiences.search" },
      schema: {
        operationId: "searchExperiences",
        summary: "Search experiences",
        description:
          "Experiences near a place that are on during the dates given: festivals, concerts, matches, markets, " +
          "shows and exhibitions. The place is a location's slug, such as hermanus, or a point. Dates match an experience's sessions, so an experience is returned only when it " +
          "is on inside the range, and each result carries the sessions that fall inside it. An experience is " +
          "bookable when it is confirmed, its booking is open and it has a link to book through: its booking link, " +
          "or failing that its own page. An attribute, option, tag or season that does not exist is refused " +
          "with invalid_input. The filters decide " +
          "what is returned; the query text only orders the results.",
        tags: ["Experiences"],
        body: searchExperiencesInputSchema,
        response: { 200: searchExperiencesResultSchema, ...errorResponses, ...bodyErrorResponses },
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
          "are reported, though search no longer returns them; experiences that are over are not. An experience " +
          "that was on during the dates before a change since then, and is not now, is reported with movedOut " +
          "true and the sessions it has now, outside the dates. Each result has " +
          "the change that matters most to a planner and every change since, newest first. The most recent change " +
          "comes first.",
        tags: ["Experiences"],
        body: experienceChangesInputSchema,
        response: { 200: experienceChangesResultSchema, ...errorResponses, ...bodyErrorResponses },
      },
    },
    (request) => catalogue.getChangesSince(request.body),
  );
  return Promise.resolve();
};
