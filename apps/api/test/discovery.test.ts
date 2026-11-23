import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { source } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { SaveSourceInput } from "../src/core/discovery/ports.ts";
import { AppError } from "../src/core/shared/errors.ts";
import { createHarness, type Harness } from "./helpers/harness.ts";

// Saving sources against the database, through the Discovery service.

let harness: Harness;

const quicket: SaveSourceInput = {
  name: "Quicket",
  kind: "quicket",
  locationSlug: "hermanus",
  credentialsSetting: "QUICKET_API_KEY",
};

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.delete(source);
  for (const [slug, latitude, longitude] of [
    ["hermanus", -34.4187, 19.2345],
    ["stanford", -34.4416, 19.4589],
  ] as const) {
    await harness.services.catalogue.saveLocation({
      name: slug,
      slug,
      country: "South Africa",
      region: "Western Cape",
      timezone: "Africa/Johannesburg",
      latitude,
      longitude,
    });
  }
});

describe("Discovery repository: saving a source", () => {
  test("creates the source with the defaults from the settings", async () => {
    const saved = await harness.services.discovery.saveSource(quicket);
    const [row] = await harness.db.select().from(source).where(eq(source.id, saved.id));

    assert.ok(row);
    assert.equal(row.kind, "quicket");
    assert.equal(row.credentialsSetting, "QUICKET_API_KEY");
    assert.deepEqual(row.syncState, {});
    assert.ok(row.fetchIntervalHours > 0);
    assert.ok(row.missedRunsBeforeRemoval > 0);
    assert.ok(row.maxProcessingAttempts > 0);
  });

  test("updates the source with the same name in the same location, and keeps its sync state", async () => {
    const first = await harness.services.discovery.saveSource(quicket);
    // The adapter's sync state, as a run would have left it.
    await harness.db
      .update(source)
      .set({ syncState: { lastModified: "2026-11-20T08:00:00Z" } })
      .where(eq(source.id, first.id));

    const second = await harness.services.discovery.saveSource({ ...quicket, priority: 30, fetchIntervalHours: 6 });

    assert.equal(second.id, first.id);
    assert.equal(second.priority, 30);
    assert.equal(second.fetchIntervalHours, 6);
    const rows = await harness.db.select().from(source);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.syncState, { lastModified: "2026-11-20T08:00:00Z" });
  });

  test("keeps a source of the same name in another location apart", async () => {
    await harness.services.discovery.saveSource(quicket);
    await harness.services.discovery.saveSource({ ...quicket, locationSlug: "stanford" });
    assert.equal(await harness.db.$count(source), 2);
  });

  test("refuses a location Catalogue does not have", async () => {
    await assert.rejects(
      harness.services.discovery.saveSource({ ...quicket, locationSlug: "atlantis" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal(await harness.db.$count(source), 0);
  });
});
