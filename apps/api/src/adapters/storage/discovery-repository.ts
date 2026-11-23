import { events, listing, rawListing, run, source, type Db, type Tx } from "@magic-events/db";
import { and, asc, eq, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DiscoveryRepository, ListingVersion, Source } from "../../core/discovery/ports.ts";

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

// The pending raw listing of one version of a listing, with its raw_listing.captured domain event.
async function captureVersion(tx: Tx, listingId: string, version: ListingVersion): Promise<void> {
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
  await tx.insert(events).values({
    type: "raw_listing.captured",
    resourceId: saved.id,
    data: { listing_id: listingId, run_id: version.runId, kind: "listing" },
  });
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

    async findDueSources(now) {
      const lastRun = db
        .select({ sourceId: run.sourceId, startedAt: sql<Date>`max(${run.startedAt})`.as("last_started_at") })
        .from(run)
        .groupBy(run.sourceId)
        .as("last_run");
      const running = db
        .select({ one: sql`1` })
        .from(run)
        .where(and(eq(run.sourceId, source.id), eq(run.status, "running")));
      const rows = await db
        .select({ source })
        .from(source)
        .leftJoin(lastRun, eq(lastRun.sourceId, source.id))
        .where(
          and(
            eq(source.active, true),
            notExists(running),
            or(
              isNull(lastRun.startedAt),
              lte(
                sql`${lastRun.startedAt} + make_interval(hours => ${source.fetchIntervalHours})`,
                sql`${now.toISOString()}::timestamptz`,
              ),
            ),
          ),
        )
        // The longest waiting first.
        .orderBy(sql`${lastRun.startedAt} asc nulls first`, asc(source.name));
      return rows.map((row) => toSource(row.source));
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
        await captureVersion(tx, created.id, input);
        return created.id;
      });
    },

    async saveListingVersion(input) {
      await db.transaction(async (tx) => {
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
        await captureVersion(tx, input.listingId, input);
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
            sql`(select count(*) from ${later}
                 where ${later.sourceId} = ${listing.sourceId}
                   and ${later.status} = 'succeeded'
                   and ${later.complete}
                   and ${later.startedAt} > ${seen.startedAt}) >= ${missedRuns}`,
          ),
        );
      return rows.map((row) => row.id);
    },

    // Every listing set to removed, each with its raw listing of kind removed and its domain event, together.
    async removeListings(listingIds, runId, removedAt) {
      if (listingIds.length === 0) return;
      await db.transaction(async (tx) => {
        await tx
          .update(listing)
          .set({ state: "removed", updatedAt: sql`now()` })
          .where(inArray(listing.id, listingIds));
        const saved = await tx
          .insert(rawListing)
          .values(listingIds.map((listingId) => ({ listingId, runId, kind: "removed" as const, fetchedAt: removedAt })))
          .returning({ id: rawListing.id, listingId: rawListing.listingId });
        await tx.insert(events).values(
          saved.map((one) => ({
            type: "raw_listing.captured",
            resourceId: one.id,
            data: { listing_id: one.listingId, run_id: runId, kind: "removed" },
          })),
        );
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
          latestRawListingId: sql<string>`(select ${latest.id} from ${latest}
            where ${latest.listingId} = ${rawListing.listingId}
            order by ${latest.fetchedAt} desc, ${latest.id} desc limit 1)`,
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
        if (superseded.length > 0) {
          await tx.insert(events).values(
            superseded.map((one) => ({
              type: "raw_listing.superseded",
              resourceId: one.id,
              data: { listing_id: listingId, raw_listing_id: newerRawListingId },
            })),
          );
        }
        return superseded.map((one) => one.id);
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
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(rawListing)
          .set({ status: "processed" })
          .where(and(eq(rawListing.id, id), eq(rawListing.status, "pending")))
          .returning({ id: rawListing.id });
        if (!updated) throw new Error(`Raw listing ${id} is not pending, so it cannot be marked processed`);
        await tx.insert(events).values({ type: "raw_listing.processed", resourceId: id, data: { listing_id: listingId } });
      });
    },

    async markRawListingFailed({ id, listingId, attempts, error, willRetry }) {
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(rawListing)
          .set({ status: willRetry ? "pending" : "failed", attempts, error })
          .where(and(eq(rawListing.id, id), eq(rawListing.status, "pending")))
          .returning({ id: rawListing.id });
        if (!updated) throw new Error(`Raw listing ${id} is not pending, so it cannot be marked failed`);
        await tx.insert(events).values({
          type: "raw_listing.failed",
          resourceId: id,
          data: { listing_id: listingId, error, attempt: attempts, will_retry: willRetry },
        });
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
