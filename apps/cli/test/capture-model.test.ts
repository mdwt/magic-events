import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { z } from "zod";
import { extractionAnswerSchema } from "@magic-events/core/data-processing/extract.ts";
import { LanguageModelFailed } from "@magic-events/core/shared/language-model.ts";
import { capturedExperienceSchema, CaptureModel, type Capture } from "../src/capture-model.ts";

// The FynArts Festival is listed by two captured sources: the festival's own pages and Hermanus Tourism's festivals
// page. After a reprocess of that experience both listings are pending while one source is loaded.

function capturesOf(slug: string, address: string): Capture[] {
  const file = new URL(`../../../data/hermanus/extracted/${slug}.json`, import.meta.url);
  const experiences = z.array(capturedExperienceSchema).parse(JSON.parse(readFileSync(file, "utf8")));
  return [{ listing: { sourceListingId: address, url: address, content: "", contentType: "text/plain" }, experiences }];
}

const TOURISM = "https://hermanus-tourism.co.za/things-to-do/festivals-and-markets/";
const FYNARTS = "https://www.hermanusfynarts.co.za/event-list";
const tourism = capturesOf("hermanus-tourism", TOURISM);
const fynarts = capturesOf("hermanus-fynarts", FYNARTS);

const question = (address: string) => ({
  instructions: "",
  text: `The item is a web page, at ${address}.\n`,
  schema: extractionAnswerSchema,
});

describe("CaptureModel", () => {
  test("answers a listing of another source than the one being loaded from that source's own capture", async () => {
    const model = new CaptureModel(undefined);
    model.loadAll([...tourism, ...fynarts]);
    model.load(fynarts);

    const own = await model.ask(question(FYNARTS));
    assert.equal(own.experiences.length, fynarts[0]?.experiences.length);
    const other = await model.ask(question(TOURISM));
    assert.equal(other.experiences.length, tourism[0]?.experiences.length);
    assert.ok(other.experiences.some((experience) => experience.title === "Hermanus FynArts Festival"));
  });

  test("with the model off, a listing no source captured still fails, and says so", async () => {
    const model = new CaptureModel(undefined);
    model.loadAll([...tourism, ...fynarts]);
    model.load(fynarts);
    await assert.rejects(
      model.ask(question("https://example.com/not-captured")),
      (error: unknown) => error instanceof LanguageModelFailed && error.reason === "unavailable",
    );
  });
});
