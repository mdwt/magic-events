import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { capturedIndex } from "../src/captured-title.ts";

describe("capturedIndex", () => {
  test("finds the capture with the same title", () => {
    assert.equal(capturedIndex(["Watershed Live", "RAAF"], "RAAF"), 1);
  });

  test("finds a capture whose title the pipeline tidied: capitals, pipes and punctuation", () => {
    assert.equal(capturedIndex(["Watershed Live", "PRIDE FUN WALK"], "Pride Fun Walk"), 1);
    assert.equal(capturedIndex(["Two Cookies | Make One. Give One.", "Other"], "Two Cookies Make One. Give One"), 0);
  });

  test("takes the only capture left, whatever the title asked about", () => {
    assert.equal(capturedIndex(["Hermanus | Solstice | Secret Sunset"], "Solstice Secret Sunset"), 0);
  });

  test("among several, takes the one that shares the most words", () => {
    const captured = ["Hermanus | Solstice | Secret Sunset", "Hermanus | Summer Opener | Secret Sunrise"];
    assert.equal(capturedIndex(captured, "Summer Opener Secret Sunrise"), 1);
    assert.equal(capturedIndex(captured, "Solstice Secret Sunset"), 0);
  });

  test("finds none when no capture is left, or none shares a word", () => {
    assert.equal(capturedIndex([], "RAAF"), -1);
    assert.equal(capturedIndex(["Watershed Live", "Jeremy Loops Live"], "RAAF"), -1);
  });
});
