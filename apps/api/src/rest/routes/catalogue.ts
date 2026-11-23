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
          "What is on near a place during a stay: festivals, concerts, matches, markets, shows, exhibitions and " +
          "seasons. Give the place as a location's slug, such as hermanus, or as a point, and the first and last day " +
          "of the stay. An experience is returned only when it is on during the stay, and each result carries its " +
          "sessions during the stay: the days it is on, or the month when its days are not announced yet. An " +
          "experience is bookable when it is confirmed, its booking is open and it has a link to book through: its " +
          "booking link, or failing that its own page. The filters decide what is returned. Results come most " +
          "premium first, by tier (luxury, premium, standard, everyday; none counts as standard), and the query " +
          "text, what the traveller likes in plain words, only orders the results within a tier. An attribute, " +
          "option, tag or season that " +
          "does not exist is refused with invalid_input, and the message names the ones that do.",
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
          "What changed since you last searched, among the experiences the same search selects: new, confirmed, " +
          "rescheduled, postponed, cancelled, removed or otherwise changed. Give the same search, without its query " +
          "text, and since: when you last searched. An empty answer means nothing changed. Cancelled and removed " +
          "experiences are reported, though search no longer returns them; experiences that are over are not. An " +
          "experience that was on during the stay when you searched, and is not now, is reported with movedOut " +
          "true and the sessions it has now, outside the stay. Each result has the change that matters most to a " +
          "planner and every change since, newest first. Each change names the fields it changed, and gives what " +
          "they were before in the experience's own shapes, beside the experience as it is now. The most recent " +
          "change comes first.",
        tags: ["Experiences"],
        body: experienceChangesInputSchema,
        response: { 200: experienceChangesResultSchema, ...errorResponses, ...bodyErrorResponses },
      },
    },
    (request) => catalogue.getChangesSince(request.body),
  );
  return Promise.resolve();
};
