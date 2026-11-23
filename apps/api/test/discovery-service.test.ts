import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Catalogue, Location } from "../src/core/catalogue/ports.ts";
import type { DiscoveryRepository, SaveSourceInput, Source } from "../src/core/discovery/ports.ts";
import { DiscoveryService } from "../src/core/discovery/service.ts";
import { AppError } from "../src/core/shared/errors.ts";
import type { Logger } from "../src/core/shared/logger.ts";

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

const hermanus: Location = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Hermanus",
  slug: "hermanus",
  country: "South Africa",
  region: "Western Cape",
  timezone: "Africa/Johannesburg",
  latitude: -34.4187,
  longitude: 19.2345,
};

// A Catalogue that knows only Hermanus. Discovery uses nothing but getLocation.
const catalogue: Catalogue = {
  searchExperiences: () => Promise.reject(new Error("not used")),
  saveLocation: () => Promise.reject(new Error("not used")),
  getLocation: (by) => Promise.resolve(("slug" in by ? by.slug : by.id) === "hermanus" ? hermanus : null),
};

function setup() {
  const saved: Omit<Source, "id">[] = [];
  const repository: DiscoveryRepository = {
    upsertSource(input) {
      saved.push(input);
      return Promise.resolve({ id: "00000000-0000-4000-8000-000000000002", ...input });
    },
  };
  const service = new DiscoveryService({
    repository,
    catalogue,
    settings: { defaultFetchIntervalHours: 24, defaultMissedRunsBeforeRemoval: 3, defaultMaxProcessingAttempts: 5 },
    logger: silent,
  });
  return { service, saved };
}

const quicket: SaveSourceInput = {
  name: "Quicket",
  kind: "quicket",
  locationSlug: "hermanus",
  credentialsSetting: "QUICKET_API_KEY",
};

describe("DiscoveryService.saveSource", () => {
  test("gives a source left without them the defaults from the settings", async () => {
    const { service, saved } = setup();
    const source = await service.saveSource(quicket);

    assert.equal(source.locationId, hermanus.id);
    assert.deepEqual(saved[0], {
      name: "Quicket",
      kind: "quicket",
      locationId: hermanus.id,
      settings: {},
      credentialsSetting: "QUICKET_API_KEY",
      priority: 0,
      fetchIntervalHours: 24,
      missedRunsBeforeRemoval: 3,
      maxProcessingAttempts: 5,
      active: true,
    });
  });

  test("keeps the values the source is given", async () => {
    const { service, saved } = setup();
    await service.saveSource({
      ...quicket,
      fetchIntervalHours: 6,
      missedRunsBeforeRemoval: 1,
      maxProcessingAttempts: 2,
      priority: 20,
      active: false,
    });

    const [first] = saved;
    assert.ok(first);
    assert.equal(first.fetchIntervalHours, 6);
    assert.equal(first.missedRunsBeforeRemoval, 1);
    assert.equal(first.maxProcessingAttempts, 2);
    assert.equal(first.priority, 20);
    assert.equal(first.active, false);
  });

  test("accepts each of the five kinds", async () => {
    const { service } = setup();
    for (const kind of ["quicket", "ticketmaster", "rss_feed", "pdf_calendar", "web_page"]) {
      const source = await service.saveSource({ ...quicket, kind });
      assert.equal(source.kind, kind);
    }
  });

  test("refuses an unknown kind with invalid_input and saves nothing", async () => {
    const { service, saved } = setup();
    await assert.rejects(
      service.saveSource({ ...quicket, kind: "facebook" }),
      (error) => error instanceof AppError && error.code === "invalid_input" && error.details?.[0]?.path === "kind",
    );
    assert.equal(saved.length, 0);
  });

  test("refuses an unknown location with not_found and saves nothing", async () => {
    const { service, saved } = setup();
    await assert.rejects(
      service.saveSource({ ...quicket, locationSlug: "atlantis" }),
      (error) => error instanceof AppError && error.code === "not_found",
    );
    assert.equal(saved.length, 0);
  });
});
