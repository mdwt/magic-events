import { classificationAnswerSchema } from "../data-processing/classify.ts";
import { extractionAnswerSchema } from "../data-processing/extract.ts";
import { matchAnswerSchema } from "../data-processing/match.ts";
import { type LanguageModel, LanguageModelFailed, type LanguageModelRequest } from "../shared/language-model.ts";

// The language model with scripted answers. Each kind of call (extract, classify, match) has its own script: a
// queue of answers taken in order, or a function of the request. An answer is checked against the request's schema,
// as the real adapter does, and a LanguageModelFailed in the script is thrown. Every request is kept, so a test
// can see what the model was shown.

export type CallKind = "extract" | "classify" | "match";

type Answer = unknown;
type Script = Answer[] | ((request: LanguageModelRequest<unknown>) => Answer);

export interface FakeLanguageModel extends LanguageModel {
  requests: { kind: CallKind; request: LanguageModelRequest<unknown> }[];
  of(kind: CallKind): LanguageModelRequest<unknown>[];
}

function kindOf(request: LanguageModelRequest<unknown>): CallKind {
  if (request.schema === extractionAnswerSchema) return "extract";
  if (request.schema === classificationAnswerSchema) return "classify";
  if (request.schema === matchAnswerSchema) return "match";
  throw new Error("The fake language model does not know this kind of call.");
}

// What the model answers when a test does not say: no experiences, no values, no match.
const DEFAULTS: Record<CallKind, Answer> = {
  extract: { experiences: [] },
  classify: { attributes: [], tags: [], profile: "A profile." },
  match: { experienceId: "" },
};

export function fakeLanguageModel(scripts: Partial<Record<CallKind, Script>> = {}): FakeLanguageModel {
  const requests: FakeLanguageModel["requests"] = [];
  const queues = new Map<CallKind, Answer[]>();
  for (const [kind, script] of Object.entries(scripts) as [CallKind, Script][]) {
    if (Array.isArray(script)) queues.set(kind, [...script]);
  }

  return {
    requests,
    of: (kind) => requests.filter((entry) => entry.kind === kind).map((entry) => entry.request),
    ask<T>(request: LanguageModelRequest<T>): Promise<T> {
      const kind = kindOf(request);
      requests.push({ kind, request });
      const script = scripts[kind];
      let answer: Answer;
      if (typeof script === "function") answer = script(request);
      else {
        const queue = queues.get(kind);
        answer = queue && queue.length > 0 ? queue.shift() : DEFAULTS[kind];
      }
      if (answer instanceof LanguageModelFailed) return Promise.reject(answer);
      // A scripted answer that does not fit is a mistake in the test, so it says so loudly.
      return Promise.resolve(request.schema.parse(answer));
    },
  };
}
