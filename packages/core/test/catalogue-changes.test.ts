import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reportedChange } from "../src/catalogue/changes.ts";
import {
  experienceChangesInputSchema,
  type ChangedExperienceRecord,
  type ReportedChange,
  type ReportedStatus,
} from "../src/catalogue/ports.ts";
import { AppError } from "../src/shared/errors.ts";
import { fakeCatalogue, input, RAW_B } from "../src/testing/catalogue-fake.ts";

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
  movedOut = false,
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
      bookingUrl: `https://tickets.example.com/${id}`,
      imageUrl: null,
      pageUrl: null,
      attributes: {},
      tags: [],
      sessions: [],
      version: changes.length + 1,
      updatedAt: changes[0]?.at ?? "2026-10-01T10:00:00.000Z",
    },
    movedOut,
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

  test("an unknown tag is refused as in a search", async () => {
    const catalogue = fakeCatalogue();
    const error = await refusal(catalogue.service.getChangesSince(changesInput({ tags: ["jaz"] })));
    assert.deepEqual(error.details?.map((detail) => detail.path), ["tags.0"]);
    assert.match(error.message, /no tag jaz.*closest are: jazz/);
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

  test("bookable asks for confirmed experiences that can be booked now", async () => {
    const catalogue = fakeCatalogue();
    await catalogue.service.getChangesSince(changesInput({ bookable: true }));
    const [query] = catalogue.changes.queries;
    assert.deepEqual([query?.statuses, query?.bookable], [["confirmed"], true]);
  });

  test("an entry is bookable only with a link to book through, its booking link or its own page", async () => {
    const catalogue = fakeCatalogue();
    const withLink = record("a", "confirmed", [change("changed", "11-20")]);
    const withPage = record("b", "confirmed", [change("changed", "11-19")]);
    withPage.experience.bookingUrl = null;
    withPage.experience.pageUrl = "https://whatson.example.com/b";
    const without = record("c", "confirmed", [change("changed", "11-18")]);
    without.experience.bookingUrl = null;
    catalogue.changes.answer = { items: [withLink, withPage, without], total: 3 };
    const result = await catalogue.service.getChangesSince(changesInput());
    assert.deepEqual(
      result.items.map((item) => item.experience.bookable),
      [true, true, false],
    );
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

describe("an experience that moved out of the dates", () => {
  test("a reschedule keeps the sessions it had in the change row, which changed-since matches the dates on", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(input());
    const moved = await catalogue.service.saveExperience(
      input({
        experienceId: experience.id,
        sessions: [{ startDate: "2027-04-17", precision: "day", startTime: "18:00", endTime: "22:00" }],
        source: { ...input().source, rawListingId: RAW_B },
      }),
    );
    assert.equal(moved.change, "rescheduled");
    const previous = catalogue.writes[1]?.change?.previous?.sessions;
    assert.deepEqual(previous, experience.sessions);
    assert.deepEqual(
      experience.sessions.map((session) => session.startDate),
      ["2027-03-13"],
    );
  });

  test("a changed recurrence keeps its generated sessions in the change row too", async () => {
    const catalogue = fakeCatalogue();
    const market = (rule: string, overrides: object = {}) =>
      input({
        title: "Saturday Market",
        type: "recurring",
        sessions: [],
        recurrence: { rule, start: "2027-01-02", end: "2027-01-31" },
        ...overrides,
      });
    const { experience } = await catalogue.service.saveExperience(market("FREQ=WEEKLY;BYDAY=SA"));
    await catalogue.service.saveExperience(
      market("FREQ=WEEKLY;BYDAY=SU", { experienceId: experience.id, source: { ...input().source, rawListingId: RAW_B } }),
    );
    const previous = catalogue.writes[1]?.change?.previous?.sessions as { startDate: string; origin: string }[];
    assert.deepEqual(
      previous.map((session) => [session.startDate, session.origin]),
      [
        ["2027-01-02", "generated"],
        ["2027-01-09", "generated"],
        ["2027-01-16", "generated"],
        ["2027-01-23", "generated"],
        ["2027-01-30", "generated"],
      ],
    );
  });

  test("is reported with the change it got, marked moved out, with the sessions it has now", async () => {
    const catalogue = fakeCatalogue();
    const moved = record("a", "confirmed", [change("rescheduled", "11-20")], "open", true);
    moved.experience.sessions = [
      { startDate: "2027-08-14", endDate: "2027-08-14", precision: "day", startTime: null, endTime: null, label: null, soldOut: false },
    ];
    catalogue.changes.answer = { items: [moved, record("b", "confirmed", [change("changed", "11-15")])], total: 2 };
    const result = await catalogue.service.getChangesSince(changesInput());
    assert.deepEqual(
      result.items.map((item) => [item.experience.id, item.change.kind, item.movedOut]),
      [
        ["a", "rescheduled", true],
        ["b", "changed", false],
      ],
    );
    assert.deepEqual(result.items[0]?.experience.sessions.map((session) => session.startDate), ["2027-08-14"]);
  });
});
