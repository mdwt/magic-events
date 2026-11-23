import { createHash } from "node:crypto";
import { EmbeddingFailed, type EmbeddingModel } from "../../src/core/catalogue/ports.ts";
import type { EmbeddingSettings } from "../../src/core/shared/settings.ts";

// An embedding model with no provider behind it. A text in the table is embedded as the point the test gave it, so
// a test can say which experience is nearest to which query. Any other text gets a point of its own, far from every
// point in the table. It records each call, and can be told to fail or never to answer.

const DIMENSIONS = 1024;
// The table's points use the first dimensions; a text not in the table is put on one of the others.
const TABLE_DIMENSIONS = 16;

// The embedding settings a service built without the settings provider is given.
export const EMBEDDING_SETTINGS: EmbeddingSettings = {
  provider: "bedrock",
  model: "fake-embedding-model",
  batchSize: 100,
  queryTimeoutSeconds: 5,
  awsRegion: undefined,
};

// A unit vector of 1024 numbers pointing along the given coordinates.
export function point(coordinates: number[]): number[] {
  const vector = Array.from({ length: DIMENSIONS }, (_, index) => coordinates[index] ?? 0);
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

function elsewhere(text: string): number[] {
  const hash = createHash("sha256").update(text).digest().readUInt32BE(0);
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[TABLE_DIMENSIONS + (hash % (DIMENSIONS - TABLE_DIMENSIONS))] = 1;
  return vector;
}

export class FakeEmbeddingModel implements EmbeddingModel {
  readonly model: string;
  readonly dimensions = DIMENSIONS;
  readonly calls: { texts: string[]; purpose: "document" | "query" }[] = [];
  // Texts and the coordinates of their points.
  readonly table = new Map<string, number[]>();
  // A text this returns true for fails the call it is in.
  failOn: (text: string) => boolean = () => false;
  // True makes every call wait forever.
  hang = false;

  constructor(options: { model?: string; table?: Record<string, number[]> } = {}) {
    this.model = options.model ?? "fake-embedding-model";
    for (const [text, coordinates] of Object.entries(options.table ?? {})) this.table.set(text, coordinates);
  }

  // Every call fails from now on.
  fail(): void {
    this.failOn = () => true;
  }

  embed(texts: string[], purpose: "document" | "query"): Promise<number[][]> {
    this.calls.push({ texts, purpose });
    if (this.hang) return new Promise(() => {});
    const failing = texts.find((text) => this.failOn(text));
    if (failing !== undefined) return Promise.reject(new EmbeddingFailed(`The fake failed on "${failing}".`));
    return Promise.resolve(
      texts.map((text) => {
        const coordinates = this.table.get(text);
        return coordinates === undefined ? elsewhere(text) : point(coordinates);
      }),
    );
  }

  // The texts embedded as documents, in order.
  documents(): string[] {
    return this.calls.filter((call) => call.purpose === "document").flatMap((call) => call.texts);
  }
}
