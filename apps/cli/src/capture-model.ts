import { z } from "zod";
import { classificationAnswerSchema, type ClassificationAnswer } from "@magic-events/core/data-processing/classify.ts";
import { extractionAnswerSchema, type ExtractionAnswer } from "@magic-events/core/data-processing/extract.ts";
import { matchAnswerSchema, type MatchAnswer } from "@magic-events/core/data-processing/match.ts";
import type { FetchedListing } from "@magic-events/core/discovery/ports.ts";
import { type LanguageModel, LanguageModelFailed, type LanguageModelRequest } from "@magic-events/core/shared/language-model.ts";
import { capturedIndex } from "./captured-title.ts";
import { matchPlainly, readMatchQuestion } from "./plain-match.ts";

// The captured experiences, and the language model that answers the pipeline from them.

// ---- The capture files ----

const text = z.string().nullish();

const attributeValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);

// How premium the experience is, read one by one from each capture. A capture without one gets the attribute's
// default when it is classified.
const tier = z.enum(["luxury", "premium", "standard", "everyday"]);

export const capturedExperienceSchema = z.object({
  rawFile: z.string(),
  url: text,
  title: z.string(),
  summary: text,
  description: text,
  type: z.enum(["single", "run", "recurring"]),
  status: z.enum(["expected", "announced", "confirmed", "postponed", "cancelled"]),
  booking: z.enum(["none", "not_yet", "open", "sold_out", "closed"]),
  sessions: z
    .array(
      z.object({
        start: z.string(),
        end: text,
        precision: z.enum(["day", "month", "year"]),
        startTime: text,
        endTime: text,
        label: text,
        soldOut: z.boolean().nullish(),
        cancelled: z.boolean().nullish(),
      }),
    )
    .default([]),
  recurrence: z
    .object({
      rule: z.string(),
      start: z.string(),
      end: text,
      startTime: text,
      endTime: text,
      skipped: z.array(z.string()).nullish(),
    })
    .nullish(),
  openingHours: text,
  venue: z
    .object({ name: text, address: text, city: text, position: z.object({ lat: z.number(), lng: z.number() }).nullish() })
    .nullish(),
  price: z.object({ min: z.number().nullish(), max: z.number().nullish(), currency: text }).nullish(),
  onSaleAt: text,
  bookingClosesAt: text,
  bookingUrl: text,
  imageUrl: text,
  hints: z.array(z.string()).nullish(),
  nextEdition: z.boolean().nullish(),
  minimumAge: z.number().nullish(),
  attributes: z.object({ tier: tier.optional() }).catchall(attributeValue).nullish(),
  tags: z.array(z.string()).nullish(),
  profile: text,
});
export type CapturedExperience = z.infer<typeof capturedExperienceSchema>;

// One captured page or file, as a fetch adapter would return it, with the experiences read from it.
export interface Capture {
  listing: FetchedListing;
  experiences: CapturedExperience[];
}

// ---- The captured experiences, as the answers the pipeline expects ----

type AnswerExperience = ExtractionAnswer["experiences"][number];

// The age limit a capture recorded as its minimum age attribute, which the extraction now carries itself.
function capturedMinimumAge(experience: CapturedExperience): number | null {
  const value = experience.attributes?.minimum_age;
  const age = Array.isArray(value) ? value[0] : value;
  return typeof age === "number" ? age : typeof age === "string" && /^\d+$/.test(age) ? Number(age) : null;
}

function extractionAnswer(experience: CapturedExperience): AnswerExperience {
  const { recurrence } = experience;
  return {
    title: experience.title,
    summary: experience.summary ?? "",
    description: experience.description ?? "",
    type: experience.type,
    status: experience.status,
    booking: experience.booking,
    sessions: experience.sessions.map((session) => ({
      start: session.start,
      end: session.end ?? "",
      precision: session.precision,
      startTime: session.startTime ?? "",
      endTime: session.endTime ?? "",
      label: session.label ?? "",
      soldOut: session.soldOut ?? false,
      cancelled: session.cancelled ?? false,
    })),
    recurrence: recurrence
      ? {
          rule: recurrence.rule,
          start: recurrence.start,
          end: recurrence.end ?? "",
          startTime: recurrence.startTime ?? "",
          endTime: recurrence.endTime ?? "",
          skipped: recurrence.skipped ?? [],
        }
      : null,
    openingHours: experience.openingHours ?? "",
    venueName: experience.venue?.name ?? "",
    venueAddress: experience.venue?.address ?? "",
    city: experience.venue?.city ?? "",
    venueLatitude: experience.venue?.position?.lat ?? null,
    venueLongitude: experience.venue?.position?.lng ?? null,
    priceMin: experience.price?.min ?? null,
    priceMax: experience.price?.max ?? null,
    currency: experience.price?.currency ?? "",
    onSaleAt: experience.onSaleAt ?? "",
    bookingClosesAt: experience.bookingClosesAt ?? "",
    bookingUrl: experience.bookingUrl ?? "",
    imageUrl: experience.imageUrl ?? "",
    url: experience.url ?? "",
    hints: experience.hints ?? [],
    nextEdition: experience.nextEdition ?? false,
    minimumAge: experience.minimumAge ?? capturedMinimumAge(experience),
  };
}

function classificationAnswer(experience: CapturedExperience): ClassificationAnswer {
  return {
    attributes: Object.entries(experience.attributes ?? {}).map(([key, value]) => ({
      key,
      values: (Array.isArray(value) ? value : [value]).map(String),
    })),
    tags: experience.tags ?? [],
    profile: experience.profile ?? "",
  };
}

// ---- The language model that answers from the captures ----

function byAddress(captures: Capture[]): Map<string, CapturedExperience[]> {
  return new Map(
    captures.flatMap((capture) => (capture.listing.url === undefined ? [] : [[capture.listing.url, capture.experiences]])),
  );
}

export class CaptureModel implements LanguageModel {
  readonly #real: LanguageModel | undefined;
  #captures = new Map<string, CapturedExperience[]>();
  #every = new Map<string, CapturedExperience[]>();
  // The experiences of the listing being processed, whose classifications are asked for next.
  #current: CapturedExperience[] = [];
  // False while a raw listing with no capture is processed: every question about it goes to the real model.
  #replaying = false;
  readonly counts = { matchedPlainly: 0, askedModel: 0, modelFailed: 0, leftUnmatched: 0 };
  // Each plain match, as the extracted title and the title of the experience it was matched to.
  readonly plainMatches: { title: string; matched: string }[] = [];

  constructor(real: LanguageModel | undefined) {
    this.#real = real;
  }

  // The captures of every source in the manifest, by the page's address. A raw listing of another source than the
  // one being loaded can be pending, after a reprocess of an experience that two sources list, and it is answered
  // from its own capture too, never sent to the real model or failed for want of one.
  loadAll(captures: Capture[]): void {
    this.#every = byAddress(captures);
  }

  // The captures of the source being loaded. They come first where two sources captured the same address.
  load(captures: Capture[]): void {
    this.#captures = byAddress(captures);
    this.#current = [];
  }

  async ask<T>(request: LanguageModelRequest<T>): Promise<T> {
    const schema: unknown = request.schema;

    if (schema === extractionAnswerSchema) {
      const url = /^The item is [^\n]*?, at (\S+)\.$/m.exec(request.text)?.[1];
      const captured = url === undefined ? undefined : (this.#captures.get(url) ?? this.#every.get(url));
      this.#replaying = captured !== undefined;
      this.#current = [];
      if (captured) {
        this.#current = [...captured];
        const answer: ExtractionAnswer = { experiences: captured.map(extractionAnswer) };
        return request.schema.parse(answer);
      }
    }

    if (schema === classificationAnswerSchema) {
      const title = /^Title: (.*)$/m.exec(request.text)?.[1] ?? "";
      const index = capturedIndex(
        this.#current.map((experience) => experience.title),
        title,
      );
      const captured = this.#current[index];
      if (captured) {
        // Taken out, so a second experience with the same title on the page gets its own.
        this.#current.splice(index, 1);
        return request.schema.parse(classificationAnswer(captured));
      }
    }

    if (schema === matchAnswerSchema && this.#replaying) {
      const none: MatchAnswer = { experienceId: "" };
      const question = readMatchQuestion(request.text);
      const plain = question ? matchPlainly(question) : { verdict: "unsure" as const };
      if (question && plain.verdict === "sure") {
        this.counts.matchedPlainly += 1;
        const matched = question.candidates.find((candidate) => candidate.id === plain.id)?.title ?? plain.id;
        this.plainMatches.push({ title: question.title, matched });
        const answer: MatchAnswer = { experienceId: plain.id };
        return request.schema.parse(answer);
      }
      if (plain.verdict === "none") return request.schema.parse(none);
      if (!this.#real) {
        this.counts.leftUnmatched += 1;
        return request.schema.parse(none);
      }
      this.counts.askedModel += 1;
      try {
        return await this.#real.ask(request);
      } catch (error) {
        if (!(error instanceof LanguageModelFailed)) throw error;
        this.counts.modelFailed += 1;
        return request.schema.parse(none);
      }
    }

    // A raw listing with no capture, which the pipeline's own fetch left pending: it is processed the real way.
    if (!this.#real) throw new LanguageModelFailed("unavailable", "No capture answers this, and the model is off.");
    return this.#real.ask(request);
  }
}
