import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Location, SaveExperienceInput, StoredExperience } from "../src/core/catalogue/ports.ts";
import { addMonths, dayIn, ruleDays } from "../src/core/catalogue/recurrence.ts";
import { fakeCatalogue, HERMANUS, input, RAW_B } from "./helpers/catalogue-fake.ts";

// The sessions Catalogue generates for a recurring experience. Today is Monday 23 November 2026 in Hermanus.

function market(recurrence: SaveExperienceInput["recurrence"], overrides: Partial<SaveExperienceInput> = {}) {
  return input({
    title: "Hermanus Country Market",
    type: "recurring",
    status: "confirmed",
    booking: "none",
    sessions: [],
    recurrence,
    ...overrides,
  });
}

function days(experience: StoredExperience, origin?: "listed" | "generated"): string[] {
  return experience.sessions
    .filter((session) => origin === undefined || session.origin === origin)
    .map((session) => session.startDate);
}

describe("generated sessions", () => {
  test("every Saturday over a closed range, with the recurrence's times", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(
      market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2027-01-01", end: "2027-01-31", startTime: "08:30", endTime: "12:00" }),
    );
    assert.deepEqual(days(experience), ["2027-01-02", "2027-01-09", "2027-01-16", "2027-01-23", "2027-01-30"]);
    assert.ok(experience.sessions.every((session) => session.origin === "generated"));
    assert.deepEqual(
      experience.sessions[0],
      {
        startDate: "2027-01-02",
        endDate: "2027-01-02",
        precision: "day",
        startTime: "08:30:00",
        endTime: "12:00:00",
        label: null,
        soldOut: false,
        status: "scheduled",
        origin: "generated",
      },
    );
    assert.deepEqual(experience.recurrence, {
      rule: "FREQ=WEEKLY;BYDAY=SA",
      start: "2027-01-01",
      end: "2027-01-31",
      startTime: "08:30:00",
      endTime: "12:00:00",
      skipped: [],
    });
  });

  test("an open-ended recurrence runs from today to the session horizon", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01" }));
    const generated = days(experience);
    assert.equal(generated[0], "2026-11-28");
    // 24 months on from 23 November 2026 is 23 November 2028; the Saturday before it is the 18th.
    assert.equal(generated.at(-1), "2028-11-18");
    assert.equal(generated.length, 104);
  });

  test("the first Friday of the month", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(
      market({ rule: "FREQ=MONTHLY;BYDAY=1FR", start: "2027-01-01", end: "2027-06-30" }),
    );
    assert.deepEqual(days(experience), ["2027-01-01", "2027-02-05", "2027-03-05", "2027-04-02", "2027-05-07", "2027-06-04"]);
  });

  test("leaves out skipped dates", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(
      market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-12-01", end: "2027-01-10", skipped: ["2026-12-26", "2027-01-02"] }),
    );
    assert.deepEqual(days(experience), ["2026-12-05", "2026-12-12", "2026-12-19", "2027-01-09"]);
  });

  test("keeps extra listed dates as listed sessions and does not duplicate a date they cover", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(
      market(
        { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-12-01", end: "2026-12-31", startTime: "09:00" },
        {
          sessions: [
            { startDate: "2026-12-23", precision: "day", startTime: "17:00", label: "Christmas night market" },
            { startDate: "2026-12-19", precision: "day", startTime: "17:00", label: "Late market" },
          ],
        },
      ),
    );
    assert.deepEqual(days(experience, "listed"), ["2026-12-19", "2026-12-23"]);
    assert.deepEqual(days(experience, "generated"), ["2026-12-05", "2026-12-12", "2026-12-26"]);
    assert.deepEqual(days(experience), ["2026-12-05", "2026-12-12", "2026-12-19", "2026-12-23", "2026-12-26"]);
  });

  test("generates no sessions in the past", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2019-01-05" }));
    assert.equal(days(experience)[0], "2026-11-28");
    assert.ok(days(experience).every((day) => day >= "2026-11-23"));

    const ended = await catalogue.service.saveExperience(
      market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-01-01", end: "2026-06-30" }),
    );
    assert.deepEqual(ended.experience.sessions, []);
  });

  test("includes today when the rule gives it", async () => {
    const catalogue = fakeCatalogue();
    const { experience } = await catalogue.service.saveExperience(
      market({ rule: "FREQ=WEEKLY;BYDAY=MO", start: "2026-11-01", end: "2026-12-07" }),
    );
    assert.deepEqual(days(experience), ["2026-11-23", "2026-11-30", "2026-12-07"]);
  });
});

describe("as time passes and the rule changes", () => {
  test("a changed rule replaces the generated sessions from today on and keeps listed ones and past ones", async () => {
    const catalogue = fakeCatalogue();
    const recurrence = { rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01", end: "2027-01-31" };
    const extra = [{ startDate: "2026-12-23", precision: "day" as const }];
    const first = await catalogue.service.saveExperience(market(recurrence, { sessions: extra }));
    const id = first.experience.id;

    catalogue.at("2026-12-14T10:00:00.000Z");
    const result = await catalogue.service.saveExperience(
      market({ ...recurrence, rule: "FREQ=WEEKLY;BYDAY=SU" }, { experienceId: id, sessions: extra, source: { ...input().source, rawListingId: RAW_B } }),
    );

    assert.equal(result.change, "rescheduled");
    assert.equal(result.experience.version, 2);
    assert.deepEqual(days(result.experience, "listed"), ["2026-12-23"]);
    assert.deepEqual(days(result.experience, "generated"), [
      // Saturdays before today stay as they were.
      "2026-11-28",
      "2026-12-05",
      "2026-12-12",
      // Sundays from today on.
      "2026-12-20",
      "2026-12-27",
      "2027-01-03",
      "2027-01-10",
      "2027-01-17",
      "2027-01-24",
      "2027-01-31",
    ]);
    assert.deepEqual(catalogue.writes[1]?.change?.previous?.recurrence, {
      rule: "FREQ=WEEKLY;BYDAY=SA",
      start: "2026-11-01",
      end: "2027-01-31",
      startTime: null,
      endTime: null,
      skipped: [],
    });
  });

  test("sessions generated further ahead as time passes are saved but are not a change", async () => {
    const catalogue = fakeCatalogue();
    const first = await catalogue.service.saveExperience(market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01" }));
    const id = first.experience.id;

    catalogue.at("2027-01-04T10:00:00.000Z");
    const result = await catalogue.service.saveExperience(
      market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01" }, { experienceId: id }),
    );
    assert.equal(result.changed, false);
    assert.equal(result.change, null);
    assert.equal(result.experience.version, 1);
    assert.equal(days(result.experience).at(-1), "2028-12-30");
    // The Saturdays already generated, before today, are kept.
    assert.equal(days(result.experience)[0], "2026-11-28");
    const write = catalogue.writes[1];
    assert.ok(write);
    assert.equal(write.change, null);
    assert.equal(write.event, null);
    assert.equal(write.replace.sessions, true);
  });

  test("a recurring experience that becomes a single loses its generated sessions", async () => {
    const catalogue = fakeCatalogue();
    const first = await catalogue.service.saveExperience(market({ rule: "FREQ=WEEKLY;BYDAY=SA", start: "2026-11-01" }));
    const result = await catalogue.service.saveExperience(
      input({ experienceId: first.experience.id, title: "Hermanus Country Market", booking: "none" }),
    );
    assert.equal(result.experience.recurrence, null);
    assert.deepEqual(days(result.experience), ["2027-03-13"]);
    assert.equal(result.change, "rescheduled");
  });
});

describe("days and timezones", () => {
  test("today is the day in the location's timezone", async () => {
    // 22:30 UTC on 23 November is 00:30 on 24 November in Hermanus.
    const catalogue = fakeCatalogue({ now: "2026-11-23T22:30:00.000Z" });
    const { experience } = await catalogue.service.saveExperience(
      market({ rule: "FREQ=DAILY", start: "2026-11-20", end: "2026-11-26" }),
    );
    assert.deepEqual(days(experience), ["2026-11-24", "2026-11-25", "2026-11-26"]);
    assert.equal(dayIn("Pacific/Honolulu", new Date("2026-11-23T05:00:00.000Z")), "2026-11-22");
    assert.equal(dayIn("Pacific/Auckland", new Date("2026-11-23T12:00:00.000Z")), "2026-11-24");
  });

  test("no day drifts across a daylight-saving change", async () => {
    const london: Location = { ...HERMANUS, id: "00000000-0000-4000-8000-0000000000bb", timezone: "Europe/London" };
    const sydney: Location = { ...HERMANUS, id: "00000000-0000-4000-8000-0000000000cc", timezone: "Australia/Sydney" };
    const catalogue = fakeCatalogue({ locations: [london, sydney] });
    // The clocks go forward in London on 28 March 2027 and back in Sydney on 4 April 2027.
    for (const location of [london, sydney]) {
      const { experience } = await catalogue.service.saveExperience(
        market(
          { rule: "FREQ=WEEKLY;BYDAY=SU", start: "2027-03-21", end: "2027-04-11", startTime: "10:00" },
          { locationId: location.id },
        ),
      );
      assert.deepEqual(days(experience), ["2027-03-21", "2027-03-28", "2027-04-04", "2027-04-11"]);
      assert.ok(experience.sessions.every((session) => session.startTime === "10:00:00"));
    }
  });

  test("the rule's days and month arithmetic stay on calendar days", () => {
    assert.deepEqual(ruleDays({ rule: "FREQ=MONTHLY;BYMONTHDAY=31", start: "2027-01-01" }, "2027-01-01", "2027-05-31"), [
      "2027-01-31",
      "2027-03-31",
      "2027-05-31",
    ]);
    assert.deepEqual(ruleDays({ rule: "FREQ=WEEKLY;BYDAY=SA;COUNT=2", start: "2027-01-01" }, "2027-01-01", "2027-12-31"), [
      "2027-01-02",
      "2027-01-09",
    ]);
    assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
    assert.equal(addMonths("2026-11-23", 24), "2028-11-23");
  });
});
