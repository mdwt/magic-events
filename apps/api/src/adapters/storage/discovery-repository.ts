import { source, type Db } from "@magic-events/db";
import { sql } from "drizzle-orm";
import type { DiscoveryRepository, Source } from "../../core/discovery/ports.ts";

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
  };
}
