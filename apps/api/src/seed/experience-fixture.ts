import {
  experience,
  experienceAttributeValue,
  experienceSession,
  experienceTag,
  type Db,
} from "@magic-events/db";

// Experiences inserted directly, for tests and the sample seed. There is no save-experience use case yet:
// experiences will come from Data processing. No change rows or domain events are written.

type AttributeValue = string | number | boolean;

export interface ExperienceFixture {
  locationId: string;
  title: string;
  // Derived from the title when left out.
  slug?: string;
  type?: "single" | "run" | "recurring";
  status?: "expected" | "announced" | "confirmed" | "postponed" | "cancelled" | "removed" | "past";
  booking?: "none" | "not_yet" | "open" | "sold_out" | "closed";
  summary?: string;
  description?: string;
  profile?: string;
  timezone?: string;
  openingHours?: string;
  venue?: { name?: string; address?: string; city?: string; lat?: number; lng?: number };
  price?: { min?: number; max?: number; currency?: string };
  onSaleAt?: Date;
  bookingClosesAt?: Date;
  bookingUrl?: string;
  imageUrl?: string;
  pageUrl?: string;
  recurrence?: { rule: string; start: string; end?: string; startTime?: string; endTime?: string; skipped?: string[] };
  sessions: {
    startDate: string;
    // Defaults to the end of the start date's day, month or year, by precision.
    endDate?: string;
    precision?: "day" | "month" | "year";
    startTime?: string;
    endTime?: string;
    label?: string;
    status?: "scheduled" | "cancelled";
    soldOut?: boolean;
    origin?: "listed" | "generated";
  }[];
  attributes?: Record<string, AttributeValue | AttributeValue[]>;
  tags?: string[];
}

export async function insertExperienceFixture(db: Db, fixture: ExperienceFixture): Promise<string> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(experience)
      .values({
        locationId: fixture.locationId,
        title: fixture.title,
        slug: fixture.slug ?? slugify(fixture.title),
        summary: fixture.summary,
        description: fixture.description,
        profile: fixture.profile,
        type: fixture.type ?? "single",
        status: fixture.status ?? "confirmed",
        booking: fixture.booking ?? "none",
        timezone: fixture.timezone ?? "Africa/Johannesburg",
        openingHours: fixture.openingHours,
        venueName: fixture.venue?.name,
        venueAddress: fixture.venue?.address,
        city: fixture.venue?.city,
        latitude: fixture.venue?.lat,
        longitude: fixture.venue?.lng,
        priceMin: fixture.price?.min,
        priceMax: fixture.price?.max,
        currency: fixture.price?.currency,
        onSaleAt: fixture.onSaleAt,
        bookingClosesAt: fixture.bookingClosesAt,
        bookingUrl: fixture.bookingUrl,
        imageUrl: fixture.imageUrl,
        pageUrl: fixture.pageUrl,
        recurrenceRule: fixture.recurrence?.rule,
        recurrenceStart: fixture.recurrence?.start,
        recurrenceEnd: fixture.recurrence?.end,
        recurrenceStartTime: fixture.recurrence?.startTime,
        recurrenceEndTime: fixture.recurrence?.endTime,
        recurrenceSkipped: fixture.recurrence?.skipped,
      })
      .returning({ id: experience.id });
    if (inserted === undefined) throw new Error(`Inserting the experience ${fixture.title} returned no row`);
    const experienceId = inserted.id;

    if (fixture.sessions.length > 0) {
      await tx.insert(experienceSession).values(
        fixture.sessions.map((session) => {
          const precision = session.precision ?? "day";
          return {
            experienceId,
            startDate: session.startDate,
            endDate: session.endDate ?? endOf(session.startDate, precision),
            precision,
            startTime: session.startTime,
            endTime: session.endTime,
            label: session.label,
            status: session.status ?? "scheduled",
            soldOut: session.soldOut ?? false,
            origin: session.origin ?? "listed",
          };
        }),
      );
    }

    const values = Object.entries(fixture.attributes ?? {}).flatMap(([attributeKey, value]) =>
      (Array.isArray(value) ? value : [value]).map((one) => ({ experienceId, attributeKey, value: one })),
    );
    if (values.length > 0) await tx.insert(experienceAttributeValue).values(values);

    const tags = [...new Set(fixture.tags ?? [])];
    if (tags.length > 0) await tx.insert(experienceTag).values(tags.map((tag) => ({ experienceId, tag })));

    return experienceId;
  });
}

function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The last day of the day, month or year that a date falls in, as YYYY-MM-DD.
function endOf(date: string, precision: "day" | "month" | "year"): string {
  if (precision === "day") return date;
  const start = new Date(`${date}T00:00:00Z`);
  const end =
    precision === "month"
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
      : new Date(Date.UTC(start.getUTCFullYear(), 11, 31));
  return end.toISOString().slice(0, 10);
}
