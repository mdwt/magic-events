import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AppError } from "../src/shared/errors.ts";
import { LanguageModelFailed } from "../src/shared/language-model.ts";
import { answered, extraction, session } from "./fixtures/processing/answers.ts";
import { LISTING, OTHER_LISTING, RAW, rawListing, setup, stored } from "./fixtures/processing/fakes.ts";
import { fakeLanguageModel } from "../src/testing/fake-language-model.ts";

// processNext with fakes of Discovery, Catalogue, the repository and the language model: no database.

const whaleFestival = answered({
  title: "Hermanus Whale Festival",
  status: "confirmed",
  booking: "none",
  sessions: [session({ start: "2027-09-24", end: "2027-09-26" })],
  hints: ["Festival", "Family"],
});

describe("processNext", () => {
  test("returns null when nothing is pending, and asks the model nothing", async () => {
    const { service, model } = setup({ pending: [] });
    assert.equal(await service.processNext(), null);
    assert.equal(model.requests.length, 0);
  });

  test("extracts, classifies, saves, appends to the warehouse and marks the raw listing processed", async () => {
    const model = fakeLanguageModel({
      extract: [
        extraction(
          answered({
            url: "https://fynarts.example.com/festival-2027",
            venueLatitude: -34.4187,
            venueLongitude: 19.2345,
          }),
        ),
      ],
      classify: [
        {
          attributes: [
            { key: "category", values: ["visual_arts", "music"] },
            { key: "mood", values: ["festive"] },
          ],
          tags: ["jazz", "festivals"],
          profile: "A ten-day arts festival across Hermanus.",
        },
      ],
    });
    const { service, state } = setup({ model });
    const outcome = await service.processNext();

    assert.deepEqual(outcome, {
      rawListingId: RAW,
      listingId: LISTING,
      sourceName: "FynArts site",
      outcome: "processed",
      experiences: 1,
      created: 1,
      changed: 0,
      unlinked: 0,
      error: null,
    });
    const [saved] = state.saves;
    assert.ok(saved);
    assert.equal(saved.experienceId, undefined);
    assert.equal(saved.title, "Hermanus FynArts");
    assert.equal(saved.status, "announced");
    assert.equal(saved.booking, "not_yet");
    assert.equal(saved.pageUrl, "https://fynarts.example.com/festival-2027");
    assert.deepEqual(saved.venue, { city: "Hermanus", position: { lat: -34.4187, lng: 19.2345 } });
    assert.deepEqual(saved.sessions, [
      {
        startDate: "2027-06-12",
        endDate: "2027-06-21",
        precision: "day",
        startTime: undefined,
        endTime: undefined,
        label: undefined,
        soldOut: undefined,
        cancelled: undefined,
      },
    ]);
    assert.deepEqual(saved.attributes, { category: ["visual_arts", "music"], scale: ["local"] });
    // The model's tag, then the season its dates fall in.
    assert.deepEqual(saved.tags, ["jazz", "whale-season"]);
    assert.equal(saved.profile, "A ten-day arts festival across Hermanus.");
    assert.deepEqual(saved.source, { listingId: LISTING, rawListingId: RAW });
    assert.equal(saved.precedence, "lead");

    assert.equal(state.warehouse.length, 1);
    assert.equal(state.warehouse[0]?.rawListingId, RAW);
    assert.equal(state.warehouse[0].version, 1);
    assert.equal(state.warehouse[0].experience.title, "Hermanus FynArts");

    assert.deepEqual(
      state.undefinedValues.map(({ kind, value }) => ({ kind, value })),
      [
        { kind: "attribute", value: "mood" },
        { kind: "tag", value: "festivals" },
      ],
    );
    assert.equal(state.undefinedValues[0]?.rawListingId, RAW);
    assert.equal(state.undefinedValues[0].extractedExperience.title, "Hermanus FynArts");
    assert.deepEqual(state.undefinedValues[0].modelAnswer.tags, ["jazz", "festivals"]);
    assert.deepEqual(state.processed, [RAW]);
  });

  test("classifies each experience on its own, with the experience in the text and the definitions in the instructions", async () => {
    const model = fakeLanguageModel({ extract: [extraction(answered(), whaleFestival)] });
    const { service } = setup({ model });
    await service.processNext();
    const classifications = model.of("classify");
    assert.equal(classifications.length, 2);
    assert.match(classifications[0]?.text ?? "", /^Title: Hermanus FynArts/);
    assert.match(classifications[1]?.text ?? "", /^Title: Hermanus Whale Festival[\s\S]*labels: Festival, Family/);
    assert.match(classifications[0]?.instructions ?? "", /- visual_arts \(Visual arts\): Exhibitions/);
    assert.equal(classifications[0]?.instructions, classifications[1]?.instructions);
  });

  test("a removed raw listing removes the listing's links, with no extraction", async () => {
    const { service, state, model } = setup({
      pending: [rawListing({ kind: "removed", content: null, contentType: null })],
      experiences: [stored()],
    });
    const outcome = await service.processNext();
    assert.equal(outcome?.outcome, "processed");
    assert.equal(outcome.unlinked, 1);
    assert.deepEqual(state.removals, [{ listingId: LISTING, rawListingId: RAW }]);
    assert.equal(model.requests.length, 0);
    assert.deepEqual(state.processed, [RAW]);
  });

  test("a listing that describes nothing is processed, and the links it had are removed", async () => {
    const { service, state } = setup({ experiences: [stored()] });
    const outcome = await service.processNext();
    assert.equal(outcome?.outcome, "processed");
    assert.equal(outcome.experiences, 0);
    assert.equal(outcome.unlinked, 1);
    assert.deepEqual(state.removals, [{ listingId: LISTING, experienceId: stored().id, rawListingId: RAW }]);
    assert.deepEqual(state.warehouse, []);
    assert.deepEqual(state.processed, [RAW]);
  });

  test("processPending goes on until nothing is pending, or until the limit", async () => {
    const pending = [rawListing(), rawListing({ id: "raw-2" }), rawListing({ id: "raw-3" })];
    assert.equal((await setup({ pending }).service.processPending()).length, 3);
    assert.equal((await setup({ pending }).service.processPending({ limit: 2 })).length, 2);
  });
});

describe("A raw listing that fails", () => {
  const failures = [
    { name: "the model declines", model: () => fakeLanguageModel({ extract: [new LanguageModelFailed("declined")] }) },
    {
      name: "the classifier's answer has the wrong shape",
      model: () =>
        fakeLanguageModel({ extract: [extraction(answered())], classify: [new LanguageModelFailed("wrong_shape")] }),
    },
  ];

  for (const failure of failures) {
    test(`when ${failure.name}: nothing is saved, it is marked failed, and it is logged at warn`, async () => {
      const { service, state, failures: marked, logs } = setup({ model: failure.model(), experiences: [stored()] });
      const outcome = await service.processNext();
      assert.equal(outcome?.outcome, "failed");
      assert.match(outcome.error ?? "", /^The language model failed/);
      assert.deepEqual(state.saves, []);
      assert.deepEqual(state.removals, []);
      assert.deepEqual(state.warehouse, []);
      assert.deepEqual(state.processed, []);
      assert.equal(marked.length, 1);
      assert.equal(marked[0]?.id, RAW);
      const failed = logs.find((line) => line.message === "Raw listing failed");
      assert.equal(failed?.level, "warn");
      assert.equal(failed.context.source, "FynArts site");
    });
  }

  test("when Catalogue refuses a save, everything saved before it rolls back", async () => {
    const { service, state, failures, logs } = setup({
      model: fakeLanguageModel({ extract: [extraction(answered())] }),
      saveFails: new AppError("invalid_input", "The sessions are not valid."),
    });
    const outcome = await service.processNext();
    assert.equal(outcome?.error, "invalid_input: The sessions are not valid.");
    assert.deepEqual(state.saves, []);
    assert.equal(failures.length, 1);
    assert.equal(logs.find((line) => line.message === "Raw listing failed")?.level, "warn");
  });

  test("a system error is logged at error, and the rest of the work rolls back", async () => {
    const model = fakeLanguageModel({ extract: [extraction(answered(), whaleFestival)] });
    let calls = 0;
    const { service, state, logs } = setup({ model });
    // The second classification blows up after the first experience was saved.
    const ask = model.ask.bind(model);
    model.ask = (request) => {
      if (request.instructions.includes("Attributes:") && ++calls === 2) return Promise.reject(new Error("socket hang up"));
      return ask(request);
    };
    const outcome = await service.processNext();
    assert.equal(outcome?.error, "socket hang up");
    assert.deepEqual(state.saves, []);
    assert.deepEqual(state.warehouse, []);
    assert.equal(logs.find((line) => line.message === "Raw listing failed")?.level, "error");
  });

  test("a source kind with no extractor fails with a clear error", async () => {
    const { service, failures } = setup({
      pending: [rawListing({ source: { ...rawListing().source, kind: "quicket" } })],
    });
    const outcome = await service.processNext();
    assert.equal(outcome?.outcome, "failed");
    assert.equal(outcome.error, 'No extractor reads the source kind "quicket" yet.');
    assert.equal(failures[0]?.error, outcome.error);
  });

  test("is retried until it reaches its limit", async () => {
    const model = fakeLanguageModel({ extract: () => new LanguageModelFailed("timed_out") });
    const { service, failures } = setup({ model, maxAttempts: 3 });
    const outcomes = await service.processPending();
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome),
      ["failed", "failed", "failed"],
    );
    assert.deepEqual(
      failures.map((failure) => failure.willRetry),
      [true, true, false],
    );
  });
});

describe("Matching", () => {
  test("a listing of one experience that links to one still open updates it, whatever its title now", async () => {
    const linked = stored({ title: "FynArts (dates to be announced)" });
    const { service, state, model } = setup({
      model: fakeLanguageModel({ extract: [extraction(answered())] }),
      experiences: [linked],
    });
    await service.processNext();
    assert.equal(state.saves[0]?.experienceId, linked.id);
    assert.equal(model.of("match").length, 0);
    assert.deepEqual(state.removals, []);
  });

  test("among several, each extracted experience is matched to the linked one with its title, and the others lose the link", async () => {
    const fynArts = stored({ id: "e-fynarts" });
    const whales = stored({ id: "e-whales", title: "Hermanus Whale Festival", firstDate: "2027-09-24", lastDate: "2027-09-26" });
    const gone = stored({ id: "e-gone", title: "Kalfiefees" });
    const { service, state } = setup({
      model: fakeLanguageModel({ extract: [extraction(whaleFestival, answered())] }),
      experiences: [fynArts, whales, gone],
      candidates: [],
    });
    const outcome = await service.processNext();
    assert.deepEqual(
      state.saves.map((save) => save.experienceId),
      ["e-whales", "e-fynarts"],
    );
    assert.deepEqual(state.removals, [{ listingId: LISTING, experienceId: "e-gone", rawListingId: RAW }]);
    assert.equal(outcome?.unlinked, 1);
  });

  test("otherwise a candidate with the same title and overlapping dates is matched in code", async () => {
    const candidate = stored({ id: "e-other", title: "The Hermanus FynArts 2027", listingIds: [OTHER_LISTING] });
    const { service, state, model } = setup({
      model: fakeLanguageModel({ extract: [extraction(answered())] }),
      experiences: [candidate],
    });
    await service.processNext();
    assert.equal(state.saves[0]?.experienceId, "e-other");
    assert.equal(model.of("match").length, 0);
  });

  test("when no title matches, the model picks among the candidates", async () => {
    const candidate = stored({ id: "e-other", title: "FynArts Festival of the Arts", listingIds: [OTHER_LISTING] });
    const model = fakeLanguageModel({ extract: [extraction(answered())], match: [{ experienceId: "e-other" }] });
    const { service, state } = setup({ model, experiences: [candidate] });
    await service.processNext();
    assert.equal(state.saves[0]?.experienceId, "e-other");
    const [request] = model.of("match");
    assert.match(request?.text ?? "", /Title: Hermanus FynArts[\s\S]*- ID e-other: FynArts Festival of the Arts/);
  });

  test("a pick that is not among the candidates makes a new experience", async () => {
    const candidate = stored({ id: "e-other", title: "Something else", listingIds: [OTHER_LISTING] });
    const model = fakeLanguageModel({ extract: [extraction(answered())], match: [{ experienceId: "invented" }] });
    const { service, state } = setup({ model, experiences: [candidate] });
    await service.processNext();
    assert.equal(state.saves[0]?.experienceId, undefined);
  });

  test("two extracted experiences never match the same stored one", async () => {
    const candidate = stored({ id: "e-other", title: "Hermanus FynArts", listingIds: [OTHER_LISTING] });
    const { service, state } = setup({
      model: fakeLanguageModel({ extract: [extraction(answered(), answered())] }),
      experiences: [candidate],
    });
    await service.processNext();
    assert.deepEqual(
      state.saves.map((save) => save.experienceId),
      ["e-other", undefined],
    );
  });

  test("final experiences are never candidates", async () => {
    const past = stored({ id: "e-past", title: "Hermanus FynArts", status: "past", listingIds: [OTHER_LISTING] });
    const { service, state } = setup({
      model: fakeLanguageModel({ extract: [extraction(answered())] }),
      candidates: [past],
    });
    await service.processNext();
    assert.equal(state.saves[0]?.experienceId, undefined);
  });

  test("a matched experience is led by this listing when its source's priority is highest, ties included", async () => {
    const candidate = stored({ id: "e-other", listingIds: [OTHER_LISTING] });
    const lower = setup({
      model: fakeLanguageModel({ extract: [extraction(answered())] }),
      experiences: [candidate],
      priorities: { [OTHER_LISTING]: 20 },
    });
    await lower.service.processNext();
    assert.equal(lower.state.saves[0]?.precedence, "fill");

    const tie = setup({
      model: fakeLanguageModel({ extract: [extraction(answered())] }),
      experiences: [candidate],
      priorities: { [OTHER_LISTING]: 10 },
    });
    await tie.service.processNext();
    assert.equal(tie.state.saves[0]?.precedence, "lead");
  });
});
