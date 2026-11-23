import {
  attribute,
  attributeOption,
  season,
  seasonPeriod,
  tag,
  undefinedValue,
  warehouseExperience,
  type Db,
} from "@magic-events/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AttributeDefinition, DataProcessingRepository, Season } from "../../data-processing/ports.ts";
import { differsFromStored } from "./upsert.ts";

export function createDataProcessingRepository(db: Db): DataProcessingRepository {
  return {
    // The attribute and its whole option set in one transaction: the options given replace the ones stored. Only
    // what differs is written. An option keeps its row while its key stays, and updated_at moves only when the
    // attribute or one of its options changed.
    async upsertAttribute(input) {
      return db.transaction(async (tx) => {
        const fields = {
          name: input.name,
          description: input.description,
          type: input.type,
          defaultValue: input.defaultValue,
          multiple: input.multiple,
          filterable: input.filterable,
        };
        // The upsert locks the attribute's row even when it writes nothing, so two saves of it compare in turn.
        const [written] = await tx
          .insert(attribute)
          .values({ key: input.key, ...fields })
          .onConflictDoUpdate({
            target: attribute.key,
            set: { ...fields, updatedAt: sql`now()` },
            setWhere: differsFromStored([
              attribute.name,
              attribute.description,
              attribute.type,
              attribute.defaultValue,
              attribute.multiple,
              attribute.filterable,
            ]),
          })
          .returning();
        const row = written ?? (await tx.select().from(attribute).where(eq(attribute.key, input.key)))[0];
        if (!row) throw new Error("Saving the attribute returned no row");

        const stored = new Map(
          (await tx.select().from(attributeOption).where(eq(attributeOption.attributeId, row.id))).map((option) => [
            option.key,
            option,
          ]),
        );
        const added: (typeof attributeOption.$inferInsert)[] = [];
        let changed = false;
        for (const [position, { key, name, description }] of input.options.entries()) {
          const found = stored.get(key);
          stored.delete(key);
          if (!found) {
            added.push({ attributeId: row.id, key, name, description, position });
          } else if (found.name !== name || found.description !== description || found.position !== position) {
            await tx.update(attributeOption).set({ name, description, position }).where(eq(attributeOption.id, found.id));
            changed = true;
          }
        }
        // What is left of the stored options is not in the save.
        const removed = [...stored.values()].map((option) => option.id);
        if (removed.length > 0) await tx.delete(attributeOption).where(inArray(attributeOption.id, removed));
        if (added.length > 0) await tx.insert(attributeOption).values(added);
        if (!written && (changed || removed.length > 0 || added.length > 0)) {
          await tx.update(attribute).set({ updatedAt: sql`now()` }).where(eq(attribute.id, row.id));
        }

        const saved: AttributeDefinition = {
          key: row.key,
          name: row.name,
          description: row.description,
          type: row.type,
          defaultValue: row.defaultValue ?? null,
          multiple: row.multiple,
          filterable: row.filterable,
          options: input.options.map(({ key, name, description }) => ({ key, name, description })),
        };
        return saved;
      });
    },

    // A tag saved as it is stored is left as it is, updated_at too.
    async upsertTag(input) {
      const fields = { name: input.name, description: input.description };
      const [written] = await db
        .insert(tag)
        .values({ slug: input.slug, ...fields })
        .onConflictDoUpdate({
          target: tag.slug,
          set: { ...fields, updatedAt: sql`now()` },
          setWhere: differsFromStored([tag.name, tag.description]),
        })
        .returning();
      const row = written ?? (await db.select().from(tag).where(eq(tag.slug, input.slug)))[0];
      if (!row) throw new Error("Saving the tag returned no row");
      return { slug: row.slug, name: row.name, description: row.description };
    },

    // The season and its whole period set in one transaction: the periods given replace the ones stored. Only
    // what differs is written. A period is known by its start date and keeps its row while that stays, and
    // updated_at moves only when the season or one of its periods changed.
    async upsertSeason(input) {
      return db.transaction(async (tx) => {
        const fields = { name: input.name, description: input.description };
        // The upsert locks the season's row even when it writes nothing, so two saves of it compare in turn.
        const [written] = await tx
          .insert(season)
          .values({ locationId: input.locationId, slug: input.slug, ...fields })
          .onConflictDoUpdate({
            target: [season.locationId, season.slug],
            set: { ...fields, updatedAt: sql`now()` },
            setWhere: differsFromStored([season.name, season.description]),
          })
          .returning();
        const row =
          written ??
          (
            await tx
              .select()
              .from(season)
              .where(and(eq(season.locationId, input.locationId), eq(season.slug, input.slug)))
          )[0];
        if (!row) throw new Error("Saving the season returned no row");

        const stored = new Map(
          (await tx.select().from(seasonPeriod).where(eq(seasonPeriod.seasonId, row.id))).map((period) => [
            period.startDate,
            period,
          ]),
        );
        const added: (typeof seasonPeriod.$inferInsert)[] = [];
        let changed = false;
        for (const { startDate, endDate } of input.periods) {
          const found = stored.get(startDate);
          stored.delete(startDate);
          if (!found) {
            added.push({ seasonId: row.id, startDate, endDate });
          } else if (found.endDate !== endDate) {
            await tx.update(seasonPeriod).set({ endDate }).where(eq(seasonPeriod.id, found.id));
            changed = true;
          }
        }
        // What is left of the stored periods is not in the save.
        const removed = [...stored.values()].map((period) => period.id);
        if (removed.length > 0) await tx.delete(seasonPeriod).where(inArray(seasonPeriod.id, removed));
        if (added.length > 0) await tx.insert(seasonPeriod).values(added);
        if (!written && (changed || removed.length > 0 || added.length > 0)) {
          await tx.update(season).set({ updatedAt: sql`now()` }).where(eq(season.id, row.id));
        }

        const periods = await tx
          .select({ startDate: seasonPeriod.startDate, endDate: seasonPeriod.endDate })
          .from(seasonPeriod)
          .where(eq(seasonPeriod.seasonId, row.id))
          .orderBy(asc(seasonPeriod.startDate));

        return {
          id: row.id,
          locationId: row.locationId,
          slug: row.slug,
          name: row.name,
          description: row.description,
          periods,
        };
      });
    },

    // Three queries, whatever the number of definitions.
    async listDefinitions() {
      const [attributes, options, tags] = await Promise.all([
        db.select().from(attribute).orderBy(asc(attribute.key)),
        db.select().from(attributeOption).orderBy(asc(attributeOption.attributeId), asc(attributeOption.position)),
        db.select({ slug: tag.slug, name: tag.name, description: tag.description }).from(tag).orderBy(asc(tag.slug)),
      ]);
      return {
        attributes: attributes.map(
          (row): AttributeDefinition => ({
            key: row.key,
            name: row.name,
            description: row.description,
            type: row.type,
            defaultValue: row.defaultValue ?? null,
            multiple: row.multiple,
            filterable: row.filterable,
            options: options
              .filter((option) => option.attributeId === row.id)
              .map((option) => ({ key: option.key, name: option.name, description: option.description })),
          }),
        ),
        tags,
      };
    },

    async listTagSlugs() {
      // A season's slug is unique in its location only, so the same one may come from several; union keeps it once.
      const rows = await db
        .select({ slug: tag.slug })
        .from(tag)
        .union(db.select({ slug: season.slug }).from(season))
        .orderBy(asc(sql`slug`));
      return rows.map((row) => row.slug);
    },

    async listSeasons(locationId) {
      const rows = await db
        .select({
          id: season.id,
          locationId: season.locationId,
          slug: season.slug,
          name: season.name,
          description: season.description,
          startDate: seasonPeriod.startDate,
          endDate: seasonPeriod.endDate,
        })
        .from(season)
        .leftJoin(seasonPeriod, eq(seasonPeriod.seasonId, season.id))
        .where(eq(season.locationId, locationId))
        .orderBy(asc(season.slug), asc(seasonPeriod.startDate));

      const seasons = new Map<string, Season>();
      for (const row of rows) {
        const found = seasons.get(row.id) ?? {
          id: row.id,
          locationId: row.locationId,
          slug: row.slug,
          name: row.name,
          description: row.description,
          periods: [],
        };
        if (row.startDate !== null && row.endDate !== null) {
          found.periods.push({ startDate: row.startDate, endDate: row.endDate });
        }
        seasons.set(row.id, found);
      }
      return [...seasons.values()];
    },

    async appendWarehouseRows(rows) {
      if (rows.length === 0) return;
      await db.insert(warehouseExperience).values(rows);
    },

    async saveUndefinedValues(rows) {
      if (rows.length === 0) return;
      await db.insert(undefinedValue).values(rows);
    },
  };
}
