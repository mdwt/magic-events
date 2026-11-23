import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reportedChange } from "../src/core/catalogue/changes.ts";
import {
  experienceChangesInputSchema,
  type ChangedExperienceRecord,
  type ReportedChange,
  type ReportedStatus,
} from "../src/core/catalogue/ports.ts";
import { AppError } from "../src/core/shared/errors.ts";
import { fakeCatalogue } from "./helpers/catalogue-fake.ts";

// Changed-since with no database: the rules the service applies to what the repository found. Today is
// 23 November 2026.

const params = { near: { lat: -34.4187, lng: 19.2345 }, from: "2027-06-10", to: "2027-06-20" };

function changesInput(overrides: object = {}) {
  return experienceChangesInputSchema.parse({ ...params, since: "2026-10-01T09:00:00Z", ...overrides });
}

function change(kind: ReportedChange["kind"], day: string): ReportedChange {
  return { kind, at: `2026-${day}T10:00:00.000Z` };
}

function record(
  id: string,
  status: ReportedStatus,
  changes: ReportedChange[],
  booking: ChangedExperienceRecord["experience"]["booking"] = "open",
): ChangedExperienceRecord {
  return {
    experience: {
      id,
      title: `Experience ${id}`,
      slug: `experience-${id}`,
      summary: null,
      description: null,
      type: "single",
      status,
      booking,
      location: { slug: "hermanus", name: "Hermanus" },
      venue: { name: null, address: null, city: null, position: null },
      distanceKm: 1.2,
      timezone: "Africa/Johannesburg",
      openingHours: null,
      price: { min: null, max: null, currency: null },
      onSaleAt: null,
      bookingClosesAt: null,
      bookingUrl: null,
      imageUrl: null,
      pageUrl: null,
      attributes: {},
      tags: [],
      sessions: [],
      version: changes.length + 1,
      updatedAt: changes[0]?.at ?? "2026-10-01T10:00:00.000Z",
    },
    changes,
  };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error;
  }
  assert.fail("expected the call to be refused");
}

describe("the time of the last search", () => {
  test("a time in the future is refused, naming since", async () => {
    const catalogue = fakeCatalogue();
    const error = await refusal(catalogue.service.getChangesSince(changesInput({ since: "2026-11-24T10:00:00Z" })));
    assert.equal(error.code, "invalid_input");
    assert.deepEqual(
      error.details?.map((detail) => detail.path),
      ["since"],
    );
    assert.match(error.message, /future/);
    assert.equal(catalogue.changes.queries.length, 0);
  });

  test("a value that is not a timestamp is refused, naming since", async () => {
    const catalogue = fakeCatalogue();
    const error = await refusal(catalogue.service.getChangesSince({ ...changesInput(), since: "last Tuesday" }));
    assert.deepEqual(
      error.details?.map((detail) => detail.path),
      ["since"],
    );
  });

  test("the time now is allowed", async () => {
    const catalogue = fakeCatalogue();
    const result = await catalogue.service.getChangesSince(changesInput({ since: "2026-11-23T10:00:00Z" }));
    assert.deepEqual(result, { items: [], total: 0, limit: 20, offset: 0 });
  });

  test("the search parameters follow the search's own rules", async () => {
    const catalogue = fakeCatalogue();
    const error = await refusal(catalogue.service.getChangesSince(changesInput({ radiusKm: 500, to: "2027-06-01" })));
    assert.deepEqual(error.details?.map((detail) => detail.path).sort(), ["radiusKm", "to"]);
  });

  test("a query text is not part of the input", () => {
    const parsed = experienceChangesInputSchema.safeParse({ ...params, since: "2026-10-01T09:00:00Z", query: "jazz" });
    assert.equal(parsed.success, false);
  });
});

describe("the query the repository is handed", () => {
  test("has the search's defaults, the time as an instant and its own paging", async () => {
    const catalogue = fakeCatalogue();
    await catalogue.service.getChangesSince(
      changesInput({ status: ["confirmed"], tags: ["jazz"], limit: 5, offset: 10 }),
    );
    assert.deepEqual(catalogue.changes.queries, [
      {
        near: params.near,
        radiusKm: 25,
        from: params.from,
        to: params.to,
        statuses: ["confirmed"],
        attributes: {},
        tags: ["jazz"],
        limit: 5,
        offset: 10,
        since: new Date("2026-10-01T09:00:00Z"),
      },
    ]);
  });

  test("bookable asks for confirmed experiences with booking open", async () => {
    const catalogue = fakeCatalogue();
    await catalogue.service.getChangesSince(changesInput({ bookable: true }));
    const [query] = catalogue.changes.queries;
    assert.deepEqual([query?.statuses, query?.bookings], [["confirmed"], ["open"]]);
  });
});

describe("the change reported", () => {
  test("of several, the one that matters most, with the full list kept newest first", async () => {
    const catalogue = fakeCatalogue();
    const changes = [change("changed", "11-20"), change("rescheduled", "11-10"), change("confirmed", "11-01")];
    catalogue.changes.answer = { items: [record("a", "confirmed", changes)], total: 1 };
    const result = await catalogue.service.getChangesSince(changesInput());
    assert.deepEqual(result.items[0]?.change, change("rescheduled", "11-10"));
    assert.deepEqual(result.items[0].changes, changes);
    assert.equal(result.items[0].experience.bookable, true);
  });

  test("first published since then is New, though it was postponed after", async () => {
    const catalogue = fakeCatalogue();
    const changes = [change("postponed", "11-20"), change("new", "10-05")];
    catalogue.changes.answer = { items: [record("a", "postponed", changes)], total: 1 };
    const [item] = (await catalogue.service.getChangesSince(changesInput())).items;
    assert.deepEqual(item?.change, change("new", "10-05"));
    assert.equal(item.experience.bookable, false);
  });

  test("published and then cancelled since then is Cancelled, and removed is Removed", async () => {
    const catalogue = fakeCatalogue();
    catalogue.changes.answer = {
      items: [
        record("a", "cancelled", [change("cancelled", "11-20"), change("new", "10-05")], "closed"),
        record("b", "removed", [change("removed", "11-15"), change("changed", "11-01"), change("new", "10-05")], "closed"),
      ],
      total: 2,
    };
    const result = await catalogue.service.getChangesSince(changesInput());
    assert.deepEqual(
      result.items.map((item) => [item.experience.id, item.experience.status, item.change.kind]),
      [
        ["a", "cancelled", "cancelled"],
        ["b", "removed", "removed"],
      ],
    );
    assert.equal(result.total, 2);
  });

  test("the order of importance: cancelled, removed, postponed, rescheduled, confirmed, new, changed", () => {
    const kinds = ["changed", "confirmed", "rescheduled", "postponed", "removed", "cancelled"] as const;
    for (let index = 0; index < kinds.length; index += 1) {
      const some = kinds.slice(0, index + 1).map((kind, day) => change(kind, `11-${String(10 + day)}`));
      assert.equal(reportedChange(some)?.kind, kinds[index]);
    }
    assert.equal(reportedChange([change("changed", "11-20"), change("new", "11-10")])?.kind, "new");
  });

  test("the latest change of the kind reported gives its time", () => {
    assert.deepEqual(reportedChange([change("changed", "11-20"), change("changed", "11-10")]), change("changed", "11-20"));
  });

  test("no change is nothing to report", async () => {
    assert.equal(reportedChange([]), null);
    const catalogue = fakeCatalogue();
    catalogue.changes.answer = { items: [record("a", "confirmed", [])], total: 1 };
    assert.deepEqual((await catalogue.service.getChangesSince(changesInput())).items, []);
  });
});
