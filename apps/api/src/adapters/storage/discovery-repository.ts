import { events, listing, rawListing, run, source, type Db, type Tx } from "@magic-events/db";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DiscoveryRepository, LastRun, ListingVersion, Source } from "../../core/discovery/ports.ts";
import type { DomainEvent, DomainEventType } from "../../core/shared/domain-events.ts";

type SourceRow = typeof source.$inferSelect;

function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    locationId: row.locationId,
    settings: row.settings,
    credentialsSetting: row.credentialsSetting,
    priority: row.priority,
    fetchIntervalHours: row.fetchIntervalHours,
    missedRunsBeforeRemoval: row.missedRunsBeforeRemoval,
    maxProcessingAttempts: row.maxProcessingAttempts,
    active: row.active,
  };
}

interface Stored {
  id: string;
  recordedAt: string;
}

// Appends domain events, one per resource, and gives back each one's ID and time by its resource ID.
async function appendEvents(
  tx: Tx,
  rows: { type: DomainEventType; resourceId: string; data: Record<string, unknown> }[],
): Promise<(resourceId: string) => Stored> {
  const saved =
    rows.length === 0
      ? []
      : await tx
          .insert(events)
          .values(rows)
          .returning({ id: events.id, resourceId: events.resourceId, recordedAt: events.recordedAt });
  const byResource = new Map(saved.map((row) => [row.resourceId, { id: row.id, recordedAt: row.recordedAt.toISOString() }]));
  return (resourceId) => {
    const stored = byResource.get(resourceId);
    if (!stored) throw new Error(`Appending the domain event of ${resourceId} returned no row`);
    return stored;
  };
}

// The pending raw listing of one version of a listing, with its raw_listing.captured domain event.
async function captureVersion(
  tx: Tx,
  listingId: string,
  version: ListingVersion,
): Promise<DomainEvent<"raw_listing.captured">> {
  const [saved] = await tx
    .insert(rawListing)
    .values({
      listingId,
      runId: version.runId,
      kind: "listing",
      fetchedAt: version.fetchedAt,
      contentType: version.contentType,
      content: version.content,
      fingerprint: version.fingerprint,
    })
    .returning({ id: rawListing.id });
  if (!saved) throw new Error("Saving the raw listing returned no row");
  const data = { listing_id: listingId, run_id: version.runId, kind: "listing" as const };
  const stored = await appendEvents(tx, [{ type: "raw_listing.captured", resourceId: saved.id, data }]);
  return { ...stored(saved.id), type: "raw_listing.captured", resourceId: saved.id, data };
}

export function createDiscoveryRepository(db: Db): DiscoveryRepository {
  return {
    async upsertSource(input) {
      const fields = {
        kind: input.kind,
        settings: input.settings,
        credentialsSetting: input.credentialsSetting,
        priority: input.priority,
        fetchIntervalHours: input.fetchIntervalHours,
        missedRunsBeforeRemoval: input.missedRunsBeforeRemoval,
        maxProcessingAttempts: input.maxProcessingAttempts,
        active: input.active,
      };
      // The sync state is the adapter's, kept between runs, so saving a source never touches it.
      const [row] = await db
        .insert(source)
        .values({ name: input.name, locationId: input.locationId, ...fields })
        .onConflictDoUpdate({ target: [source.name, source.locationId], set: { ...fields, updatedAt: sql`now()` } })
        .returning();
      if (!row) throw new Error("Saving the source returned no row");
      return toSource(row);
    },

    async listSources() {
      const rows = await db.select().from(source).orderBy(asc(source.name), asc(source.id));
      return rows.map(toSource);
    },

    async findSource(sourceId) {
      const [row] = await db.select().from(source).where(eq(source.id, sourceId));
      return row ? { ...toSource(row), syncState: row.syncState } : null;
    },

    async findLastRuns(sourceIds) {
      const bySource: Record<string, LastRun | null> = Object.fromEntries(sourceIds.map((id) => [id, null]));
      if (sourceIds.length === 0) return bySource;
      // Every source's latest run in one query.
      const rows = await db
        .selectDistinctOn([run.sourceId], {
          sourceId: run.sourceId,
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
        })
        .from(run)
        .where(inArray(run.sourceId, sourceIds))
        .orderBy(run.sourceId, desc(run.startedAt), desc(run.id));
      for (const { sourceId, ...last } of rows) bySource[sourceId] = last;
      return bySource;
    },

    async closeStaleRuns({ sourceId, startedBefore, finishedAt, error }) {
      const closed = await db
        .update(run)
        .set({ status: "failed", finishedAt, error })
        .where(
          and(
            eq(run.status, "running"),
            lt(run.startedAt, startedBefore),
            sourceId === undefined ? undefined : eq(run.sourceId, sourceId),
          ),
        )
        .returning({ id: run.id });
      return closed.length;
    },

    async saveSyncState(sourceId, syncState) {
      await db.update(source).set({ syncState, updatedAt: sql`now()` }).where(eq(source.id, sourceId));
    },

    async startRun(sourceId, startedAt) {
      const [row] = await db
        .insert(run)
        .values({ sourceId, startedAt, status: "running" })
        .returning({ id: run.id });
      if (!row) throw new Error("Starting the run returned no row");
      return row.id;
    },

    async finishRun(runId, outcome) {
      await db
        .update(run)
        .set({
          status: outcome.status,
          complete: outcome.complete,
          listingsFound: outcome.listingsFound,
          listingsNewOrChanged: outcome.listingsNewOrChanged,
          listingsUnchanged: outcome.listingsUnchanged,
          error: outcome.error,
          finishedAt: outcome.finishedAt,
        })
        .where(eq(run.id, runId));
    },

    findListings(sourceId) {
      return db
        .select({
          id: listing.id,
          sourceListingId: listing.sourceListingId,
          fingerprint: listing.fingerprint,
          state: listing.state,
        })
        .from(listing)
        .where(eq(listing.sourceId, sourceId));
    },

    // The listing, its raw listing and the domain event in one transaction.
    async saveNewListing(input) {
      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(listing)
          .values({
            sourceId: input.sourceId,
            sourceListingId: input.sourceListingId,
            url: input.url,
            firstSeenRunId: input.runId,
            lastSeenRunId: input.runId,
            fingerprint: input.fingerprint,
          })
          .returning({ id: listing.id });
        if (!created) throw new Error("Saving the listing returned no row");
        return captureVersion(tx, created.id, input);
      });
    },

    async saveListingVersion(input) {
      return db.transaction(async (tx) => {
        await tx
          .update(listing)
          .set({
            fingerprint: input.fingerprint,
            lastSeenRunId: input.runId,
            state: "listed",
            ...(input.url === null ? {} : { url: input.url }),
            updatedAt: sql`now()`,
          })
          .where(eq(listing.id, input.listingId));
        return captureVersion(tx, input.listingId, input);
      });
    },

    async markListingsSeen(listingIds, runId) {
      if (listingIds.length === 0) return;
      await db
        .update(listing)
        .set({ lastSeenRunId: runId, updatedAt: sql`now()` })
        .where(inArray(listing.id, listingIds));
    },

    async findMissedListings(sourceId, missedRuns) {
      const seen = alias(run, "seen");
      const later = alias(run, "later");
      const rows = await db
        .select({ id: listing.id })
        .from(listing)
        .innerJoin(seen, eq(seen.id, listing.lastSeenRunId))
        .where(
          and(
            eq(listing.sourceId, sourceId),
            eq(listing.state, "listed"),
            gte(
              db
                .select({ count: count() })
                .from(later)
                .where(
                  and(
                    eq(later.sourceId, listing.sourceId),
                    eq(later.status, "succeeded"),
                    eq(later.complete, true),
                    gt(later.startedAt, seen.startedAt),
                  ),
                ),
              missedRuns,
            ),
          ),
        );
      return rows.map((row) => row.id);
    },

    // Every listing set to removed, each with its raw listing of kind removed and its domain event, together.
    async removeListings(listingIds, runId, removedAt) {
      if (listingIds.length === 0) return [];
      return db.transaction(async (tx) => {
        await tx
          .update(listing)
          .set({ state: "removed", updatedAt: sql`now()` })
          .where(inArray(listing.id, listingIds));
        const saved = await tx
          .insert(rawListing)
          .values(listingIds.map((listingId) => ({ listingId, runId, kind: "removed" as const, fetchedAt: removedAt })))
          .returning({ id: rawListing.id, listingId: rawListing.listingId });
        const captured = saved.map((one) => ({
          type: "raw_listing.captured" as const,
          resourceId: one.id,
          data: { listing_id: one.listingId, run_id: runId, kind: "removed" as const },
        }));
        const stored = await appendEvents(tx, captured);
        return captured.map((event) => ({ ...stored(event.resourceId), ...event }));
      });
    },

    async lockOldestPendingRawListing() {
      const latest = alias(rawListing, "latest");
      const [row] = await db
        .select({
          id: rawListing.id,
          listingId: rawListing.listingId,
          kind: rawListing.kind,
          contentType: rawListing.contentType,
          content: rawListing.content,
          fetchedAt: rawListing.fetchedAt,
          attempts: rawListing.attempts,
          url: listing.url,
          source: {
            id: source.id,
            name: source.name,
            kind: source.kind,
            priority: source.priority,
            locationId: source.locationId,
          },
          // Ties on the fetched time are broken by ID, the same way the oldest is picked.
          latestRawListingId: sql<string>`(${db
            .select({ id: latest.id })
            .from(latest)
            .where(eq(latest.listingId, rawListing.listingId))
            .orderBy(desc(latest.fetchedAt), desc(latest.id))
            .limit(1)})`,
        })
        .from(rawListing)
        .innerJoin(listing, eq(listing.id, rawListing.listingId))
        .innerJoin(source, eq(source.id, listing.sourceId))
        .where(eq(rawListing.status, "pending"))
        .orderBy(asc(rawListing.fetchedAt), asc(rawListing.id))
        .limit(1)
        .for("update", { of: rawListing, skipLocked: true });
      if (!row) return null;
      const { latestRawListingId, fetchedAt, ...rest } = row;
      return { rawListing: { ...rest, fetchedAt: fetchedAt.toISOString() }, latestRawListingId };
    },

    async supersedeOlderVersions({ listingId, newerRawListingId }) {
      return db.transaction(async (tx) => {
        const older = alias(rawListing, "older");
        const newer = alias(rawListing, "newer");
        // A version another worker holds is left to it.
        const candidates = tx
          .select({ id: older.id })
          .from(older)
          .where(
            and(
              eq(older.listingId, listingId),
              ne(older.id, newerRawListingId),
              inArray(older.status, ["pending", "failed"]),
              lte(older.fetchedAt, tx.select({ fetchedAt: newer.fetchedAt }).from(newer).where(eq(newer.id, newerRawListingId))),
            ),
          )
          .for("update", { skipLocked: true });
        const superseded = await tx
          .update(rawListing)
          .set({ status: "superseded" })
          .where(inArray(rawListing.id, candidates))
          .returning({ id: rawListing.id });
        const appended = superseded.map((one) => ({
          type: "raw_listing.superseded" as const,
          resourceId: one.id,
          data: { listing_id: listingId, raw_listing_id: newerRawListingId },
        }));
        const stored = await appendEvents(tx, appended);
        return appended.map((event) => ({ ...stored(event.resourceId), ...event }));
      });
    },

    async findRawListingForMark(rawListingId) {
      const [row] = await db
        .select({
          id: rawListing.id,
          listingId: rawListing.listingId,
          status: rawListing.status,
          attempts: rawListing.attempts,
          maxProcessingAttempts: source.maxProcessingAttempts,
        })
        .from(rawListing)
        .innerJoin(listing, eq(listing.id, rawListing.listingId))
        .innerJoin(source, eq(source.id, listing.sourceId))
        .where(eq(rawListing.id, rawListingId));
      return row ?? null;
    },

    async markRawListingProcessed({ id, listingId }) {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(rawListing)
          .set({ status: "processed" })
          .where(and(eq(rawListing.id, id), eq(rawListing.status, "pending")))
          .returning({ id: rawListing.id });
        if (!updated) throw new Error(`Raw listing ${id} is not pending, so it cannot be marked processed`);
        const data = { listing_id: listingId };
        const stored = await appendEvents(tx, [{ type: "raw_listing.processed", resourceId: id, data }]);
        return { ...stored(id), type: "raw_listing.processed" as const, resourceId: id, data };
      });
    },

    async markRawListingFailed({ id, listingId, attempts, error, willRetry }) {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(rawListing)
          .set({ status: willRetry ? "pending" : "failed", attempts, error })
          .where(and(eq(rawListing.id, id), eq(rawListing.status, "pending")))
          .returning({ id: rawListing.id });
        if (!updated) throw new Error(`Raw listing ${id} is not pending, so it cannot be marked failed`);
        const data = { listing_id: listingId, error, attempt: attempts, will_retry: willRetry };
        const stored = await appendEvents(tx, [{ type: "raw_listing.failed", resourceId: id, data }]);
        return { ...stored(id), type: "raw_listing.failed" as const, resourceId: id, data };
      });
    },

    async findListingPriorities(listingIds) {
      if (listingIds.length === 0) return {};
      const rows = await db
        .select({ id: listing.id, priority: source.priority })
        .from(listing)
        .innerJoin(source, eq(source.id, listing.sourceId))
        .where(inArray(listing.id, listingIds));
      return Object.fromEntries(rows.map((row) => [row.id, row.priority]));
    },
  };
}
