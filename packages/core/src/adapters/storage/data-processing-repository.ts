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
import { asc, eq, sql } from "drizzle-orm";
import type { AttributeDefinition, DataProcessingRepository, Season } from "../../data-processing/ports.ts";

export function createDataProcessingRepository(db: Db): DataProcessingRepository {
  return {
    // The attribute and its whole option set in one transaction: the options given replace the ones stored.
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
        const [row] = await tx
          .insert(attribute)
          .values({ key: input.key, ...fields })
          .onConflictDoUpdate({ target: attribute.key, set: { ...fields, updatedAt: sql`now()` } })
          .returning();
        if (!row) throw new Error("Saving the attribute returned no row");

        await tx.delete(attributeOption).where(eq(attributeOption.attributeId, row.id));
        const options =
          input.options.length === 0
            ? []
            : await tx
                .insert(attributeOption)
                .values(input.options.map((option, position) => ({ attributeId: row.id, ...option, position })))
                .returning();

        const saved: AttributeDefinition = {
          key: row.key,
          name: row.name,
          description: row.description,
          type: row.type,
          defaultValue: row.defaultValue ?? null,
          multiple: row.multiple,
          filterable: row.filterable,
          options: options
            .sort((a, b) => a.position - b.position)
            .map((option) => ({ key: option.key, name: option.name, description: option.description })),
        };
        return saved;
      });
    },

    async upsertTag(input) {
      const fields = { name: input.name, description: input.description };
      const [row] = await db
        .insert(tag)
        .values({ slug: input.slug, ...fields })
        .onConflictDoUpdate({ target: tag.slug, set: { ...fields, updatedAt: sql`now()` } })
        .returning();
      if (!row) throw new Error("Saving the tag returned no row");
      return { slug: row.slug, name: row.name, description: row.description };
    },

    // The season and its whole period set in one transaction: the periods given replace the ones stored.
    async upsertSeason(input) {
      return db.transaction(async (tx) => {
        const fields = { name: input.name, description: input.description };
        const [row] = await tx
          .insert(season)
          .values({ locationId: input.locationId, slug: input.slug, ...fields })
          .onConflictDoUpdate({ target: [season.locationId, season.slug], set: { ...fields, updatedAt: sql`now()` } })
          .returning();
        if (!row) throw new Error("Saving the season returned no row");

        await tx.delete(seasonPeriod).where(eq(seasonPeriod.seasonId, row.id));
        if (input.periods.length > 0) {
          await tx
            .insert(seasonPeriod)
            .values(input.periods.map((period) => ({ seasonId: row.id, ...period })));
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
