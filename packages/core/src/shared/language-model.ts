import type { z } from "zod";

// The language model port. It is shared by Data processing and Discovery and belongs to no domain.
// The domain that asks owns the instructions and the shape of the answer. The adapter owns everything about
// the provider: its SDK, model name, keys, limits, caching and how its failures are read.

export type LanguageModelFailure =
  | "declined" // the model refused the request
  | "cut_off" // the answer ran out of room before it was complete
  | "wrong_shape" // the answer does not fit the schema
  | "too_long" // the content is too long for the model, and is never cut to fit
  | "timed_out" // no answer within the timeout
  | "unavailable"; // the provider could not be reached or turned the call away

// The one kind of failure `ask` has. The caller never reads a provider's own errors.
export class LanguageModelFailed extends Error {
  readonly reason: LanguageModelFailure;

  constructor(reason: LanguageModelFailure, message?: string) {
    super(message ?? `The language model failed: ${reason}`);
    this.name = "LanguageModelFailed";
    this.reason = reason;
  }
}

export interface LanguageModelRequest<T> {
  // What the model must do. The same for every call of one kind.
  instructions: string;
  // What this call is about.
  text: string;
  // A file to read, such as a PDF calendar.
  document?: { mediaType: string; base64: string };
  // The shape of the answer.
  schema: z.ZodType<T>;
}

export interface LanguageModel {
  // One request with one answer, already checked against the schema. Fails only with LanguageModelFailed.
  ask<T>(request: LanguageModelRequest<T>): Promise<T>;
}
