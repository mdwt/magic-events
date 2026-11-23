import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { searchExperiencesResultSchema } from "../src/core/catalogue/ports.ts";
import { insertExperienceFixture } from "../src/seed/experience-fixture.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";

let harness: Harness;
let key: string;

const valid = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-06-10", to: "2027-06-20" };

function searchWith(body: object, headers: Record<string, string> = { authorization: `Bearer ${key}` }) {
  return harness.app.inject({ method: "POST", url: "/v1/experiences/search", headers, payload: body });
}

interface ErrorBody {
  error: { code: string; message: string; details: { path: string; message: string }[]; requestId: string };
}

function errorOf(response: { json: () => unknown }): ErrorBody["error"] {
  const body = response.json() as ErrorBody;
  assert.equal(typeof body.error.message, "string");
  assert.equal(typeof body.error.requestId, "string");
  return body.error;
}

before(async () => {
  harness = await createHarness();
  const hermanus = await harness.services.catalogue.saveLocation({
    name: "Hermanus",
    slug: "hermanus",
    country: "ZA",
    region: "Western Cape",
    timezone: "Africa/Johannesburg",
    latitude: -34.4187,
    longitude: 19.2345,
  });
  await insertExperienceFixture(harness.db, {
    locationId: hermanus.id,
    title: "Hermanus Whale Festival",
    booking: "open",
    sessions: [{ startDate: "2027-06-08", endDate: "2027-06-10" }],
    attributes: { category: ["nature_and_wildlife"] },
    tags: ["whales"],
  });
  ({ key } = await harness.createCaller());
});

after(async () => {
  await harness.close();
});

describe("POST /v1/experiences/search", () => {
  test("returns 200 in the documented shape", async () => {
    const response = await searchWith(valid);
    assert.equal(response.statusCode, 200);
    const result = searchExperiencesResultSchema.parse(response.json());
    assert.equal(result.total, 1);
    assert.deepEqual([result.limit, result.offset], [20, 0]);
    assert.equal(result.items[0]?.title, "Hermanus Whale Festival");
    assert.equal(result.items[0].bookable, true);
  });

  test("takes the key from an x-api-key header too", async () => {
    const response = await searchWith(valid, { "x-api-key": key });
    assert.equal(response.statusCode, 200);
  });

  test("refuses an unknown property", async () => {
    const response = await searchWith({ ...valid, city: "Hermanus" });
    assert.equal(response.statusCode, 400);
    const error = errorOf(response);
    assert.equal(error.code, "invalid_input");
    assert.ok(error.details.some((detail) => detail.path === "city"), JSON.stringify(error.details));
  });

  test("refuses a date that is not a date", async () => {
    const response = await searchWith({ ...valid, from: "2027-13-01" });
    assert.equal(response.statusCode, 400);
    const error = errorOf(response);
    assert.equal(error.code, "invalid_input");
    assert.ok(error.details.some((detail) => detail.path === "from"), JSON.stringify(error.details));
  });

  test("refuses a latitude out of range", async () => {
    const response = await searchWith({ ...valid, near: { lat: 91, lng: 19.2345 } });
    assert.equal(response.statusCode, 400);
    const error = errorOf(response);
    assert.ok(error.details.some((detail) => detail.path === "near.lat"), JSON.stringify(error.details));
  });

  test("refuses a radius above the limit and names it", async () => {
    const response = await searchWith({ ...valid, radiusKm: 500 });
    assert.equal(response.statusCode, 400);
    const error = errorOf(response);
    assert.equal(error.code, "invalid_input");
    assert.match(error.message, /200 km/);
    assert.deepEqual(
      error.details.map((detail) => detail.path),
      ["radiusKm"],
    );
  });

  test("refuses a last day before the first", async () => {
    const response = await searchWith({ ...valid, from: "2027-06-20", to: "2027-06-10" });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(
      errorOf(response).details.map((detail) => detail.path),
      ["to"],
    );
  });

  test("returns 401 without a key", async () => {
    const response = await searchWith(valid, {});
    assert.equal(response.statusCode, 401);
    assert.equal(errorOf(response).code, "unauthenticated");
  });

  test("returns 403 for a suspended tenant", async () => {
    const suspended = await harness.createCaller({ tenantStatus: "suspended" });
    const response = await searchWith(valid, { authorization: `Bearer ${suspended.key}` });
    assert.equal(response.statusCode, 403);
    assert.equal(errorOf(response).code, "forbidden");
  });
});
