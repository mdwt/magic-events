import {
  experience,
  experienceAttributeValue,
  experienceSession,
  experienceTag,
  location,
  type Db,
} from "@magic-events/db";
import { and, asc, count, eq, exists, gte, inArray, isNotNull, lte, min, sql, type SQL } from "drizzle-orm";
import {
  SEARCHABLE_STATUSES,
  type AttributeFilter,
  type CatalogueRepository,
  type ExperienceRecord,
  type ExperienceSearchQuery,
  type Location,
  type SearchableStatus,
} from "../../core/catalogue/ports.ts";

// The mean radius of the Earth, in kilometres.
const EARTH_RADIUS_KM = 6371.0088;

export function createCatalogueRepository(db: Db): CatalogueRepository {
  return {
    async searchExperiences(query) {
      const where = searchConditions(db, query);
      const distance = distanceKm(query.near);

      const [page, [counted]] = await Promise.all([
        db
          .select({
            id: experience.id,
            title: experience.title,
            slug: experience.slug,
            summary: experience.summary,
            description: experience.description,
            type: experience.type,
            status: experience.status,
            booking: experience.booking,
            locationSlug: location.slug,
            locationName: location.name,
            venueName: experience.venueName,
            venueAddress: experience.venueAddress,
            city: experience.city,
            latitude: experience.latitude,
            longitude: experience.longitude,
            distanceKm: distance,
            timezone: experience.timezone,
            openingHours: experience.openingHours,
            priceMin: experience.priceMin,
            priceMax: experience.priceMax,
            currency: experience.currency,
            onSaleAt: experience.onSaleAt,
            bookingClosesAt: experience.bookingClosesAt,
            bookingUrl: experience.bookingUrl,
            imageUrl: experience.imageUrl,
            version: experience.version,
            updatedAt: experience.updatedAt,
          })
          .from(experience)
          .innerJoin(location, eq(location.id, experience.locationId))
          .where(where)
          .orderBy(...searchOrder(db, query))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(experience)
          .innerJoin(location, eq(location.id, experience.locationId))
          .where(where),
      ]);
      const total = counted?.total ?? 0;
      if (page.length === 0) return { items: [], total };

      const ids = page.map((row) => row.id);
      const [sessions, attributeValues, tags] = await Promise.all([
        db
          .select({
            experienceId: experienceSession.experienceId,
            startDate: experienceSession.startDate,
            endDate: experienceSession.endDate,
            precision: experienceSession.precision,
            startTime: experienceSession.startTime,
            endTime: experienceSession.endTime,
            label: experienceSession.label,
            soldOut: experienceSession.soldOut,
          })
          .from(experienceSession)
          .where(and(inArray(experienceSession.experienceId, ids), sessionInRange(query)))
          .orderBy(
            asc(experienceSession.startDate),
            sql`${experienceSession.startTime} asc nulls first`,
            asc(experienceSession.endDate),
            asc(experienceSession.id),
          ),
        db
          .select({
            experienceId: experienceAttributeValue.experienceId,
            key: experienceAttributeValue.attributeKey,
            value: experienceAttributeValue.value,
          })
          .from(experienceAttributeValue)
          .where(inArray(experienceAttributeValue.experienceId, ids))
          .orderBy(asc(experienceAttributeValue.attributeKey), asc(experienceAttributeValue.value)),
        db
          .select({ experienceId: experienceTag.experienceId, tag: experienceTag.tag })
          .from(experienceTag)
          .where(inArray(experienceTag.experienceId, ids))
          .orderBy(asc(experienceTag.tag)),
      ]);

      const sessionsOf = groupBy(sessions, (row) => row.experienceId);
      const attributesOf = groupBy(attributeValues, (row) => row.experienceId);
      const tagsOf = groupBy(tags, (row) => row.experienceId);

      const items = page.map((row): ExperienceRecord => {
        const attributes: ExperienceRecord["attributes"] = {};
        for (const { key, value } of attributesOf.get(row.id) ?? []) {
          (attributes[key] ??= []).push(value);
        }
        return {
          id: row.id,
          title: row.title,
          slug: row.slug,
          summary: row.summary,
          description: row.description,
          type: row.type,
          status: searchable(row.status),
          booking: row.booking,
          location: { slug: row.locationSlug, name: row.locationName },
          venue: {
            name: row.venueName,
            address: row.venueAddress,
            city: row.city,
            position: row.latitude !== null && row.longitude !== null ? { lat: row.latitude, lng: row.longitude } : null,
          },
          distanceKm: Math.round(row.distanceKm * 10) / 10,
          timezone: row.timezone,
          openingHours: row.openingHours,
          price: { min: row.priceMin, max: row.priceMax, currency: row.currency },
          onSaleAt: row.onSaleAt?.toISOString() ?? null,
          bookingClosesAt: row.bookingClosesAt?.toISOString() ?? null,
          bookingUrl: row.bookingUrl,
          imageUrl: row.imageUrl,
          attributes,
          tags: (tagsOf.get(row.id) ?? []).map((tag) => tag.tag),
          sessions: (sessionsOf.get(row.id) ?? []).map((session) => ({
            startDate: session.startDate,
            endDate: session.endDate,
            precision: session.precision,
            startTime: session.startTime,
            endTime: session.endTime,
            label: session.label,
            soldOut: session.soldOut,
          })),
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
        };
      });
      return { items, total };
    },

    async upsertLocation(input) {
      const [saved] = await db
        .insert(location)
        .values(input)
        .onConflictDoUpdate({ target: location.slug, set: { ...input, updatedAt: new Date() } })
        .returning();
      if (saved === undefined) throw new Error("Saving a location returned no row");
      return toLocation(saved);
    },

    async findLocation(by) {
      const [found] = await db
        .select()
        .from(location)
        .where("id" in by ? eq(location.id, by.id) : eq(location.slug, by.slug))
        .limit(1);
      return found === undefined ? null : toLocation(found);
    },
  };
}

// A session that is on during the dates asked for. Cancelled sessions never match.
function sessionInRange(query: ExperienceSearchQuery): SQL | undefined {
  return and(
    eq(experienceSession.status, "scheduled"),
    lte(experienceSession.startDate, query.to),
    gte(experienceSession.endDate, query.from),
  );
}

// Every filter of the search, on the experience joined to its location.
function searchConditions(db: Db, query: ExperienceSearchQuery): SQL | undefined {
  const matchingSession = and(eq(experienceSession.experienceId, experience.id), sessionInRange(query));
  return and(
    inArray(experience.status, query.statuses),
    query.bookings === undefined ? undefined : inArray(experience.booking, query.bookings),
    lte(distanceKm(query.near), sql`${query.radiusKm}::double precision`),
    exists(db.select({ one: sql`1` }).from(experienceSession).where(matchingSession)),
    ...Object.entries(query.attributes).map(([key, filter]) =>
      exists(
        db
          .select({ one: sql`1` })
          .from(experienceAttributeValue)
          .where(
            and(
              eq(experienceAttributeValue.experienceId, experience.id),
              eq(experienceAttributeValue.attributeKey, key),
              attributeMatches(filter),
            ),
          ),
      ),
    ),
    query.tags.length === 0
      ? undefined
      : exists(
          db
            .select({ one: sql`1` })
            .from(experienceTag)
            .where(and(eq(experienceTag.experienceId, experience.id), inArray(experienceTag.tag, query.tags))),
        ),
  );
}

// One stored value against one attribute's filter. Values are jsonb, one row per value.
function attributeMatches(filter: AttributeFilter): SQL | undefined {
  const value = experienceAttributeValue.value;
  if (Array.isArray(filter)) return inArray(value, filter);
  if (typeof filter !== "object") return eq(value, filter);
  // Only a number value is compared with a range; the case keeps a text value from being cast.
  const number = sql`(case when jsonb_typeof(${value}) = 'number' then (${value})::numeric end)`;
  return and(
    isNotNull(number),
    filter.min === undefined ? undefined : sql`${number} >= ${filter.min}::numeric`,
    filter.max === undefined ? undefined : sql`${number} <= ${filter.max}::numeric`,
  );
}

// Without a query text: by the first matching session, then title. With one: keyword rank first, and the
// experiences its words do not match after the ones they do. The query text never adds or removes a result.
function searchOrder(db: Db, query: ExperienceSearchQuery): SQL[] {
  const firstSession = db
    .select({ first: min(experienceSession.startDate) })
    .from(experienceSession)
    .where(and(eq(experienceSession.experienceId, experience.id), sessionInRange(query)));
  const byDate = [sql`${firstSession} asc`, asc(experience.title), asc(experience.id)];
  if (query.query === undefined) return byDate;

  // The query text's words, stemmed and joined with OR, as in docs/data-processing.md.
  const words = sql`to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', ${query.query}::text)), ' | '))`;
  const rank = sql`(case when ${experience.searchText} @@ ${words} then ts_rank(${experience.searchText}, ${words}) end) desc nulls last`;
  return [rank, ...byDate];
}

// Kilometres from the point, by the haversine formula. The experience's own position, or its location's centre.
function distanceKm(near: { lat: number; lng: number }): SQL<number> {
  const own = and(isNotNull(experience.latitude), isNotNull(experience.longitude));
  const lat = sql`(case when ${own} then ${experience.latitude} else ${location.latitude} end)`;
  const lng = sql`(case when ${own} then ${experience.longitude} else ${location.longitude} end)`;
  const pointLat = sql`${near.lat}::double precision`;
  const pointLng = sql`${near.lng}::double precision`;
  // least() keeps rounding from pushing asin's argument above 1.
  return sql<number>`(2 * ${EARTH_RADIUS_KM}::double precision * asin(least(1, sqrt(
    power(sin(radians(${lat} - ${pointLat}) / 2), 2)
    + cos(radians(${pointLat})) * cos(radians(${lat})) * power(sin(radians(${lng} - ${pointLng}) / 2), 2)
  ))))`.mapWith(Number);
}

// The query only asks for searchable statuses, so any other is a fault in the query.
function searchable(status: string): SearchableStatus {
  const found = SEARCHABLE_STATUSES.find((value) => value === status);
  if (found === undefined) throw new Error(`Search returned an experience with status ${status}`);
  return found;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group === undefined) groups.set(key(row), [row]);
    else group.push(row);
  }
  return groups;
}

function toLocation(row: typeof location.$inferSelect): Location {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    country: row.country,
    region: row.region,
    timezone: row.timezone,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}
