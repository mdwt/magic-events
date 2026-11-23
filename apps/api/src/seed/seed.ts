import { experience, type Db } from "@magic-events/db";
import { eq } from "drizzle-orm";
import type { Services } from "../app.ts";
import type { CallerKind } from "../core/identity/ports.ts";
import { attributes } from "./data/attributes.ts";
import { HERMANUS_SLUG, hermanus } from "./data/location.ts";
import { tenants, users } from "./data/organizations.ts";
import { capeTown, sampleExperiences } from "./data/samples.ts";
import { seasons } from "./data/seasons.ts";
import { sources } from "./data/sources.ts";
import { tags } from "./data/tags.ts";
import { insertExperienceFixture } from "./experience-fixture.ts";

// The seed writes the default data through the domain services, so only each domain's repository writes its
// tables. Every write is an upsert, so running it again changes nothing and creates no duplicates.

export interface IssuedKey {
  userName: string;
  email: string;
  credentialName: string;
  kind: CallerKind;
  // The API key itself. It is stored only as a hash, so this is the one time it can be shown.
  key: string;
}

export interface DefaultsSeeded {
  attributes: number;
  tags: number;
  seasons: number;
  sources: number;
  tenants: number;
  users: number;
  issued: IssuedKey[];
}

export async function seedDefaults(services: Services): Promise<DefaultsSeeded> {
  await services.catalogue.saveLocation(hermanus);

  for (const definition of attributes) await services.dataProcessing.saveAttribute(definition);
  for (const definition of tags) await services.dataProcessing.saveTag(definition);
  for (const definition of seasons) await services.dataProcessing.saveSeason(definition);
  for (const definition of sources) await services.discovery.saveSource(definition);

  for (const tenant of tenants) await services.organizations.saveTenant(tenant);

  const issued: IssuedKey[] = [];
  for (const { keys, ...input } of users) {
    const user = await services.organizations.saveUser(input);
    const existing = new Set((await services.identity.listCredentials(user.id)).map((credential) => credential.name));
    for (const wanted of keys) {
      if (existing.has(wanted.name)) continue;
      const credential = await services.identity.issueCredential({
        userId: user.id,
        kind: wanted.kind,
        name: wanted.name,
      });
      issued.push({
        userName: user.name,
        email: user.email,
        credentialName: wanted.name,
        kind: wanted.kind,
        key: credential.key,
      });
    }
  }

  return {
    attributes: attributes.length,
    tags: tags.length,
    seasons: seasons.length,
    sources: sources.length,
    tenants: tenants.length,
    users: users.length,
    issued,
  };
}

export interface SamplesSeeded {
  inserted: string[];
  skipped: string[];
}

// Inserts the sample experiences that are not there yet. Needs the default data, for the Hermanus location.
export async function seedSamples(
  services: Services,
  db: Db,
  options: { today?: Date } = {},
): Promise<SamplesSeeded> {
  const location = await services.catalogue.getLocation({ slug: HERMANUS_SLUG });
  if (!location) throw new Error("The Hermanus location is missing. Seed the default data before the samples.");
  const capeTownLocation = await services.catalogue.saveLocation(capeTown);

  // The run date in Hermanus, as YYYY-MM-DD: en-CA formats dates that way.
  const today = (options.today ?? new Date()).toLocaleDateString("en-CA", { timeZone: location.timezone });
  const fixtures = sampleExperiences({ hermanusId: location.id, capeTownId: capeTownLocation.id, today });

  const result: SamplesSeeded = { inserted: [], skipped: [] };
  for (const fixture of fixtures) {
    const slug = fixture.slug;
    const [found] = await db.select({ id: experience.id }).from(experience).where(eq(experience.slug, slug)).limit(1);
    if (found) {
      result.skipped.push(slug);
      continue;
    }
    await insertExperienceFixture(db, fixture);
    result.inserted.push(slug);
  }
  return result;
}
