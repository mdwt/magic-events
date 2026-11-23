import { randomUUID } from "node:crypto";
import {
  events,
  experience,
  experienceAttributeValue,
  experienceChange,
  experienceSession,
  experienceSourceLink,
  experienceTag,
  location,
  type Db,
  type Tx,
} from "@magic-events/db";
import {
  and,
  asc,
  cosineDistance,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  max,
  min,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  SEARCHABLE_STATUSES,
  type AttributeFilter,
  type CatalogueRepository,
  type ExperienceRecord,
  type ExperienceSearchQuery,
  type ExperienceWrite,
  type Location,
  type SearchableStatus,
  type StoredExperience,
} from "../../core/catalogue/ports.ts";
import {
  REPORTED_STATUSES,
  type ChangedExperienceRecord,
  type ExperienceChangesQuery,
  type ReportedStatus,
} from "../../core/catalogue/ports.ts";
import type { DomainEvent } from "../../core/shared/domain-events.ts";

// Rows per insert, well inside Postgres's limit on the parameters of one statement.
const INSERT_CHUNK = 1000;

// The mean radius of the Earth, in kilometres.
const EARTH_RADIUS_KM = 6371.0088;

const EXPERIENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createCatalogueRepository(db: Db): CatalogueRepository {
  return {
    async searchExperiences(query) {
      const where = searchConditions(db, query);

      const [page, [counted]] = await Promise.all([
        selectRecords(db, query.near)
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
      const items = await toRecords(db, page, sessionInRange(query), searchable);
      return { items, total };
    },

    async findChangesSince(query) {
      // Its changes after the time given. A move to Past is never reported.
      const reportable = and(
        eq(experienceChange.experienceId, experience.id),
        gt(experienceChange.changedAt, query.since),
        ne(experienceChange.kind, "past"),
      );
      const where = and(
        or(searchableNow(db, query), cancelledOrRemoved(db, query)),
        ...placeAndClassification(db, query),
        exists(db.select({ one: sql`1` }).from(experienceChange).where(reportable)),
      );
      const latest = db.select({ latest: max(experienceChange.changedAt) }).from(experienceChange).where(reportable);

      const [page, [counted]] = await Promise.all([
        selectRecords(db, query.near)
          .where(where)
          .orderBy(sql`${latest} desc`, asc(experience.id))
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
      // A Cancelled or Removed experience carries its sessions in the dates whatever their status, as it matched.
      const ended = page.filter((row) => isReported(row.status) && !isSearchable(row.status)).map((row) => row.id);
      const sessions = or(
        sessionInRange(query),
        ended.length === 0 ? undefined : and(inArray(experienceSession.experienceId, ended), sessionOverlaps(query)),
      );
      const [records, changes] = await Promise.all([
        toRecords(db, page, sessions, reported),
        db
          .select({ experienceId: experienceChange.experienceId, kind: experienceChange.kind, at: experienceChange.changedAt })
          .from(experienceChange)
          .where(
            and(
              inArray(experienceChange.experienceId, ids),
              gt(experienceChange.changedAt, query.since),
              ne(experienceChange.kind, "past"),
            ),
          )
          .orderBy(desc(experienceChange.changedAt), desc(experienceChange.version)),
      ]);
      const changesOf = groupBy(changes, (row) => row.experienceId);
      const items = records.map(
        (record): ChangedExperienceRecord => ({
          experience: record,
          changes: (changesOf.get(record.id) ?? []).flatMap(({ kind, at }) =>
            kind === "past" ? [] : [{ kind, at: at.toISOString() }],
          ),
        }),
      );
      return { items, total };
    },

    async findUpkeepCandidates(query) {
      const lastEnd = db
        .select({ last: max(experienceSession.endDate) })
        .from(experienceSession)
        .where(eq(experienceSession.experienceId, experience.id));
      const rows = await db
        .select({ id: experience.id })
        .from(experience)
        .where(
          and(
            query.after === null ? undefined : gt(experience.id, query.after),
            or(
              and(
                inArray(experience.status, ["expected", "announced", "confirmed"]),
                sql`${lastEnd} < ${query.lastDateBefore}::date`,
              ),
              and(
                inArray(experience.booking, ["not_yet", "open"]),
                lte(experience.bookingClosesAt, query.bookingClosedBy),
              ),
              and(
                isNotNull(experience.recurrenceRule),
                isNull(experience.recurrenceEnd),
                notInArray(experience.status, ["cancelled", "removed", "past"]),
              ),
            ),
          ),
        )
        .orderBy(asc(experience.id))
        .limit(query.limit);
      return rows.map((row) => row.id);
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

    async findExperienceId(by) {
      // The ID column is a UUID, so anything else names no experience.
      if ("id" in by && !EXPERIENCE_ID.test(by.id)) return null;
      const [found] = await db
        .select({ id: experience.id })
        .from(experience)
        .where("id" in by ? eq(experience.id, by.id) : eq(experience.slug, by.slug))
        .limit(1);
      return found?.id ?? null;
    },

    async loadExperiences(by) {
      if ("ids" in by && by.ids.length === 0) return [];
      const which =
        "ids" in by
          ? inArray(experience.id, by.ids)
          : inArray(
              experience.id,
              db
                .select({ id: experienceSourceLink.experienceId })
                .from(experienceSourceLink)
                .where(eq(experienceSourceLink.listingId, by.listingId)),
            );
      const rows = await db
        .select(storedColumns)
        .from(experience)
        .where(which)
        .orderBy(asc(experience.createdAt), asc(experience.id));
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);
      const [sessions, attributeValues, tags, links] = await Promise.all([
        db
          .select()
          .from(experienceSession)
          .where(inArray(experienceSession.experienceId, ids))
          .orderBy(
            asc(experienceSession.startDate),
            sql`${experienceSession.startTime} asc nulls first`,
            asc(experienceSession.endDate),
            asc(experienceSession.id),
          ),
        db
          .select()
          .from(experienceAttributeValue)
          .where(inArray(experienceAttributeValue.experienceId, ids))
          .orderBy(asc(experienceAttributeValue.attributeKey), asc(experienceAttributeValue.value)),
        db.select().from(experienceTag).where(inArray(experienceTag.experienceId, ids)).orderBy(asc(experienceTag.tag)),
        db
          .select()
          .from(experienceSourceLink)
          .where(inArray(experienceSourceLink.experienceId, ids))
          .orderBy(asc(experienceSourceLink.createdAt), asc(experienceSourceLink.listingId)),
      ]);

      const sessionsOf = groupBy(sessions, (row) => row.experienceId);
      const attributesOf = groupBy(attributeValues, (row) => row.experienceId);
      const tagsOf = groupBy(tags, (row) => row.experienceId);
      const linksOf = groupBy(links, (row) => row.experienceId);

      return rows.map((row): StoredExperience => {
        const attributes: StoredExperience["attributes"] = {};
        for (const { attributeKey, value } of attributesOf.get(row.id) ?? []) {
          (attributes[attributeKey] ??= []).push(value);
        }
        return {
          id: row.id,
          version: row.version,
          locationId: row.locationId,
          title: row.title,
          slug: row.slug,
          summary: row.summary,
          description: row.description,
          profile: row.profile,
          type: row.type,
          status: row.status,
          booking: row.booking,
          timezone: row.timezone,
          openingHours: row.openingHours,
          venue: {
            name: row.venueName,
            address: row.venueAddress,
            city: row.city,
            position: row.latitude !== null && row.longitude !== null ? { lat: row.latitude, lng: row.longitude } : null,
          },
          price: { min: row.priceMin, max: row.priceMax, currency: row.currency },
          onSaleAt: row.onSaleAt?.toISOString() ?? null,
          bookingClosesAt: row.bookingClosesAt?.toISOString() ?? null,
          bookingUrl: row.bookingUrl,
          imageUrl: row.imageUrl,
          recurrence:
            row.recurrenceRule === null || row.recurrenceStart === null
              ? null
              : {
                  rule: row.recurrenceRule,
                  start: row.recurrenceStart,
                  end: row.recurrenceEnd,
                  startTime: row.recurrenceStartTime,
                  endTime: row.recurrenceEndTime,
                  skipped: row.recurrenceSkipped ?? [],
                },
          sessions: (sessionsOf.get(row.id) ?? []).map((session) => ({
            startDate: session.startDate,
            endDate: session.endDate,
            precision: session.precision,
            startTime: session.startTime,
            endTime: session.endTime,
            label: session.label,
            soldOut: session.soldOut,
            status: session.status,
            origin: session.origin,
          })),
          attributes,
          tags: (tagsOf.get(row.id) ?? []).map((tag) => tag.tag),
          listingIds: (linksOf.get(row.id) ?? []).map((link) => link.listingId),
        };
      });
    },

    async findMatchCandidateIds(query) {
      // The title's significant words: Postgres's English parser drops stop words and stems the rest, so
      // "The Whale Festival" and "Whale Festivals" share "whale" and "festiv".
      const theirs = sql`tsvector_to_array(to_tsvector('english', ${experience.title}))`;
      const ours = sql`tsvector_to_array(to_tsvector('english', ${query.title}::text))`;
      const shared = sql<number>`cardinality(array(select unnest(${theirs}) intersect select unnest(${ours})))`;
      const rows = await db
        .select({ id: experience.id })
        .from(experience)
        .where(
          and(
            eq(experience.locationId, query.locationId),
            inArray(experience.status, [...SEARCHABLE_STATUSES]),
            sql`${theirs} && ${ours}`,
            exists(
              db
                .select({ one: sql`1` })
                .from(experienceSession)
                .where(
                  and(
                    eq(experienceSession.experienceId, experience.id),
                    lte(experienceSession.startDate, query.to),
                    gte(experienceSession.endDate, query.from),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(shared), asc(experience.title), asc(experience.id))
        .limit(query.limit);
      return rows.map((row) => row.id);
    },

    async findTakenSlugs(base) {
      // A slug is lowercase letters, digits and hyphens, so the base holds no LIKE wildcard.
      const rows = await db
        .select({ slug: experience.slug })
        .from(experience)
        .where(or(eq(experience.slug, base), like(experience.slug, `${base}-%`)));
      return rows.map((row) => row.slug);
    },

    async saveExperiences(writes) {
      if (writes.length === 0) return [];
      // The domain events as they are appended, so the service can publish exactly what was stored.
      const appended = writes.flatMap((write) => (write.event === null ? [] : [domainEvent(write, write.event)]));
      await db.transaction(async (tx) => {
        for (const write of writes) await saveRow(tx, write);

        const ids = (part: keyof ExperienceWrite["replace"]) =>
          writes.filter((write) => write.replace[part]).map((write) => write.experience.id);
        const removed = writes.filter((write) => write.links.remove.length > 0);
        await Promise.all([
          ids("sessions").length === 0
            ? undefined
            : tx.delete(experienceSession).where(inArray(experienceSession.experienceId, ids("sessions"))),
          ids("attributes").length === 0
            ? undefined
            : tx
                .delete(experienceAttributeValue)
                .where(inArray(experienceAttributeValue.experienceId, ids("attributes"))),
          ids("tags").length === 0
            ? undefined
            : tx.delete(experienceTag).where(inArray(experienceTag.experienceId, ids("tags"))),
          removed.length === 0
            ? undefined
            : tx
                .delete(experienceSourceLink)
                .where(
                  or(
                    ...removed.map((write) =>
                      and(
                        eq(experienceSourceLink.experienceId, write.experience.id),
                        inArray(experienceSourceLink.listingId, write.links.remove),
                      ),
                    ),
                  ),
                ),
        ]);

        const replaced = (part: keyof ExperienceWrite["replace"]) => writes.filter((write) => write.replace[part]);
        const sessionRows = replaced("sessions").flatMap(({ experience: saved }) =>
          saved.sessions.map((session) => ({ experienceId: saved.id, ...session })),
        );
        const attributeRows = replaced("attributes").flatMap(({ experience: saved }) =>
          Object.entries(saved.attributes).flatMap(([attributeKey, values]) =>
            values.map((value) => ({ experienceId: saved.id, attributeKey, value })),
          ),
        );
        const tagRows = replaced("tags").flatMap(({ experience: saved }) =>
          saved.tags.map((tag) => ({ experienceId: saved.id, tag })),
        );
        const linkRows = writes.flatMap((write) =>
          write.links.add.map((listingId) => ({ experienceId: write.experience.id, listingId, createdAt: write.at })),
        );
        const changeRows = writes.flatMap((write) =>
          write.change === null
            ? []
            : [
                {
                  experienceId: write.experience.id,
                  version: write.experience.version,
                  kind: write.change.kind,
                  previous: write.change.previous,
                  changedAt: write.at,
                },
              ],
        );
        const eventRows = appended.map((event) => ({
          id: event.id,
          type: event.type,
          resourceId: event.resourceId,
          data: event.data,
          recordedAt: new Date(event.recordedAt),
        }));

        await Promise.all([
          ...chunks(sessionRows).map((rows) => tx.insert(experienceSession).values(rows)),
          ...chunks(attributeRows).map((rows) => tx.insert(experienceAttributeValue).values(rows)),
          ...chunks(tagRows).map((rows) => tx.insert(experienceTag).values(rows)),
          ...chunks(linkRows).map((rows) => tx.insert(experienceSourceLink).values(rows).onConflictDoNothing()),
          ...chunks(changeRows).map((rows) => tx.insert(experienceChange).values(rows)),
          ...chunks(eventRows).map((rows) => tx.insert(events).values(rows)),
        ]);
      });
      return appended;
    },

    async findExperiencesToEmbed(query) {
      const due = and(
        inArray(experience.status, [...SEARCHABLE_STATUSES]),
        or(isNull(experience.embedding), sql`${experience.embeddingModel} is distinct from ${query.model}`),
      );
      const [items, [counted]] = await Promise.all([
        db
          .select({ id: experience.id, title: experience.title, profile: experience.profile })
          .from(experience)
          .where(due)
          .orderBy(asc(experience.createdAt), asc(experience.id))
          .limit(query.limit),
        db.select({ total: count() }).from(experience).where(due),
      ]);
      return { items, total: counted?.total ?? 0 };
    },

    async storeEmbeddings(input) {
      if (input.embeddings.length === 0) return 0;
      const rows = sql.join(
        input.embeddings.map(
          (one) =>
            sql`(${one.id}::uuid, ${one.title}::text, ${one.profile}::text, ${JSON.stringify(one.vector)}::vector)`,
        ),
        sql`, `,
      );
      // One statement for the round. Only the embedding and its model are set: no version, no update time.
      const stored = await db
        .update(experience)
        .set({ embedding: sql`made.embedding`, embeddingModel: input.model })
        .from(sql`(values ${rows}) as made (id, title, profile, embedding)`)
        .where(
          and(
            sql`${experience.id} = made.id`,
            // The title and profile it was made from, so one that changed meanwhile is left due.
            sql`${experience.title} = made.title`,
            sql`${experience.profile} is not distinct from made.profile`,
          ),
        )
        .returning({ id: experience.id });
      return stored.length;
    },
  };
}

// The domain event row a save appends, with its ID and time set here so the row and what is returned agree.
function domainEvent(write: ExperienceWrite, event: NonNullable<ExperienceWrite["event"]>): DomainEvent {
  const row = { id: randomUUID(), resourceId: write.experience.id, recordedAt: write.at.toISOString() };
  return event.type === "experience.published"
    ? { ...row, type: event.type, data: event.data }
    : { ...row, type: event.type, data: event.data };
}

// Every column a stored experience is read from. The embedding and the search text are left out: they are
// large, and the save rules never read them.
const storedColumns = {
  id: experience.id,
  version: experience.version,
  locationId: experience.locationId,
  title: experience.title,
  slug: experience.slug,
  summary: experience.summary,
  description: experience.description,
  profile: experience.profile,
  type: experience.type,
  status: experience.status,
  booking: experience.booking,
  timezone: experience.timezone,
  openingHours: experience.openingHours,
  venueName: experience.venueName,
  venueAddress: experience.venueAddress,
  city: experience.city,
  latitude: experience.latitude,
  longitude: experience.longitude,
  priceMin: experience.priceMin,
  priceMax: experience.priceMax,
  currency: experience.currency,
  onSaleAt: experience.onSaleAt,
  bookingClosesAt: experience.bookingClosesAt,
  bookingUrl: experience.bookingUrl,
  imageUrl: experience.imageUrl,
  recurrenceRule: experience.recurrenceRule,
  recurrenceStart: experience.recurrenceStart,
  recurrenceEnd: experience.recurrenceEnd,
  recurrenceStartTime: experience.recurrenceStartTime,
  recurrenceEndTime: experience.recurrenceEndTime,
  recurrenceSkipped: experience.recurrenceSkipped,
};

// Inserts a new experience's row, or updates a stored one if it is still at the version the save was worked
// out from. A save made at the same time fails this one, and the caller's transaction rolls back.
async function saveRow(tx: Tx, write: ExperienceWrite): Promise<void> {
  const saved = write.experience;
  const values = {
    locationId: saved.locationId,
    title: saved.title,
    slug: saved.slug,
    summary: saved.summary,
    description: saved.description,
    profile: saved.profile,
    type: saved.type,
    status: saved.status,
    booking: saved.booking,
    timezone: saved.timezone,
    openingHours: saved.openingHours,
    venueName: saved.venue.name,
    venueAddress: saved.venue.address,
    city: saved.venue.city,
    latitude: saved.venue.position?.lat ?? null,
    longitude: saved.venue.position?.lng ?? null,
    priceMin: saved.price.min,
    priceMax: saved.price.max,
    currency: saved.price.currency,
    onSaleAt: saved.onSaleAt === null ? null : new Date(saved.onSaleAt),
    bookingClosesAt: saved.bookingClosesAt === null ? null : new Date(saved.bookingClosesAt),
    bookingUrl: saved.bookingUrl,
    imageUrl: saved.imageUrl,
    recurrenceRule: saved.recurrence?.rule ?? null,
    recurrenceStart: saved.recurrence?.start ?? null,
    recurrenceEnd: saved.recurrence?.end ?? null,
    recurrenceStartTime: saved.recurrence?.startTime ?? null,
    recurrenceEndTime: saved.recurrence?.endTime ?? null,
    recurrenceSkipped: saved.recurrence?.skipped ?? null,
    version: saved.version,
  };

  if (write.previousVersion === null) {
    await tx.insert(experience).values({ id: saved.id, ...values, createdAt: write.at, updatedAt: write.at });
    return;
  }
  const updated = await tx
    .update(experience)
    .set({
      ...values,
      // Only a new version is an update a client can see.
      ...(write.change === null ? {} : { updatedAt: write.at }),
      ...(write.clearEmbedding ? { embedding: null, embeddingModel: null } : {}),
    })
    .where(and(eq(experience.id, saved.id), eq(experience.version, write.previousVersion)))
    .returning({ id: experience.id });
  if (updated.length === 0) {
    throw new Error(`Experience ${saved.id} is no longer at version ${write.previousVersion}`);
  }
}

function chunks<T>(rows: T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) result.push(rows.slice(start, start + INSERT_CHUNK));
  return result;
}

// Experiences as search and changed-since return them, joined to their location, with the distance from the point.
function selectRecords(db: Db, near: { lat: number; lng: number }) {
  return db
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
      distanceKm: distanceKm(near),
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
    .innerJoin(location, eq(location.id, experience.locationId));
}

type RecordRow = Awaited<ReturnType<typeof selectRecords>>[number];

// A page of experiences as records: each with the sessions the condition picks, its attribute values and tags.
async function toRecords<S extends string>(
  db: Db,
  page: RecordRow[],
  sessionCondition: SQL | undefined,
  status: (value: string) => S,
): Promise<(Omit<ExperienceRecord, "status"> & { status: S })[]> {
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
      .where(and(inArray(experienceSession.experienceId, ids), sessionCondition))
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

  return page.map((row) => {
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
      status: status(row.status),
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
}

// A session that is on during the dates asked for. Cancelled sessions never match.
function sessionInRange(query: ExperienceSearchQuery): SQL | undefined {
  return and(eq(experienceSession.status, "scheduled"), sessionOverlaps(query));
}

// A session that overlaps the dates asked for, whatever its status.
function sessionOverlaps(query: ExperienceSearchQuery): SQL | undefined {
  return and(lte(experienceSession.startDate, query.to), gte(experienceSession.endDate, query.from));
}

// Every filter of the search, on the experience joined to its location.
function searchConditions(db: Db, query: ExperienceSearchQuery): SQL | undefined {
  return and(searchableNow(db, query), ...placeAndClassification(db, query));
}

// What search returns: the statuses and bookings asked for, with a session on during the dates.
function searchableNow(db: Db, query: ExperienceSearchQuery): SQL | undefined {
  const matchingSession = and(eq(experienceSession.experienceId, experience.id), sessionInRange(query));
  return and(
    inArray(experience.status, query.statuses),
    query.bookings === undefined ? undefined : inArray(experience.booking, query.bookings),
    exists(db.select({ one: sql`1` }).from(experienceSession).where(matchingSession)),
  );
}

// A Cancelled or Removed experience that changed-since reports though search does not: matched on its sessions in
// the dates as stored, whatever their status.
function cancelledOrRemoved(db: Db, query: ExperienceChangesQuery): SQL | undefined {
  const overlapping = and(eq(experienceSession.experienceId, experience.id), sessionOverlaps(query));
  return and(
    inArray(experience.status, ["cancelled", "removed"]),
    exists(db.select({ one: sql`1` }).from(experienceSession).where(overlapping)),
  );
}

// The filters search and changed-since share: the place and radius, the attributes and the tags.
function placeAndClassification(db: Db, query: ExperienceSearchQuery): (SQL | undefined)[] {
  return [
    lte(distanceKm(query.near), sql`${query.radiusKm}::double precision`),
    ...Object.entries(query.attributes).map(([key, filter]) => {
      const ofAttribute = and(
        eq(experienceAttributeValue.experienceId, experience.id),
        eq(experienceAttributeValue.attributeKey, key),
      );
      const values = () => db.select({ one: sql`1` }).from(experienceAttributeValue);
      const matches = exists(values().where(and(ofAttribute, attributeMatches(filter))));
      // Nothing recorded means no lower limit, so an experience with no value passes a range that has only a max.
      return isMaxOnlyRange(filter) ? or(matches, notExists(values().where(ofAttribute))) : matches;
    }),
    query.tags.length === 0
      ? undefined
      : exists(
          db
            .select({ one: sql`1` })
            .from(experienceTag)
            .where(and(eq(experienceTag.experienceId, experience.id), inArray(experienceTag.tag, query.tags))),
        ),
  ];
}

function isMaxOnlyRange(filter: AttributeFilter): boolean {
  return typeof filter === "object" && !Array.isArray(filter) && filter.min === undefined && filter.max !== undefined;
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

// Without a query text: by the first matching session, then title. With one: by the reciprocal rank fusion of the
// semantic list and the keyword list, then by the first matching session, as in docs/data-processing.md. The
// query text never adds or removes a result.
function searchOrder(db: Db, query: ExperienceSearchQuery): SQL[] {
  const firstSession = db
    .select({ first: min(experienceSession.startDate) })
    .from(experienceSession)
    .where(and(eq(experienceSession.experienceId, experience.id), sessionInRange(query)));
  const byDate = [sql`${firstSession} asc`, asc(experience.title), asc(experience.id)];
  if (query.query === undefined) return byDate;
  return [sql`${fusedScore(query.query, query.queryEmbedding)} desc`, ...byDate];
}

// How far down a list a place counts in reciprocal rank fusion.
const FUSION_K = 60;

// A candidate's score: 1 / (60 + its place) in each list it is in, added up. The places are window functions over
// the rows the filters leave, so the lists hold the candidates only, and the distance is worked out exactly for
// each of them, with no vector index.
function fusedScore(text: string, embedding: ExperienceSearchQuery["queryEmbedding"]): SQL {
  // The query text's words, stemmed and joined with OR.
  const words = sql`to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', ${text}::text)), ' | '))`;
  const inKeyword = sql`(${experience.searchText} @@ ${words})`;
  const keyword = sql`(case when ${inKeyword} then 1.0 / (${FUSION_K} + row_number() over (
    partition by ${inKeyword} order by ts_rank(${experience.searchText}, ${words}) desc, ${experience.id})) else 0 end)`;
  if (embedding === undefined) return keyword;

  // Only an embedding from the query's model is compared with it.
  const inSemantic = sql`(${experience.embedding} is not null and ${experience.embeddingModel} = ${embedding.model})`;
  const semantic = sql`(case when ${inSemantic} then 1.0 / (${FUSION_K} + row_number() over (
    partition by ${inSemantic} order by ${cosineDistance(experience.embedding, embedding.vector)}, ${experience.id})) else 0 end)`;
  return sql`(${semantic} + ${keyword})`;
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

function isSearchable(status: string): status is SearchableStatus {
  return SEARCHABLE_STATUSES.some((value) => value === status);
}

function isReported(status: string): status is ReportedStatus {
  return REPORTED_STATUSES.some((value) => value === status);
}

// The query only asks for statuses changed-since reports, so any other is a fault in the query.
function reported(status: string): ReportedStatus {
  if (!isReported(status)) throw new Error(`Changed-since returned an experience with status ${status}`);
  return status;
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
