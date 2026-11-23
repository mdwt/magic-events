import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  CreateTenantInput,
  Membership,
  Organizations,
  OrganizationsRepository,
  SaveTenantInput,
  SaveUserInput,
  Tenant,
  UpdateTenantInput,
  User,
  UserRow,
} from "./ports.ts";

// Lowercase letters and digits in words joined by single hyphens, so a slug is safe in an address.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 63;
// The plain form of an address: something, an @, and a domain with a dot. Whether it reaches anyone is not checked.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
const NAME_MAX_LENGTH = 200;

export class OrganizationsService implements Organizations {
  readonly #repository: OrganizationsRepository;
  readonly #logger: Logger;

  constructor(deps: { repository: OrganizationsRepository; logger: Logger }) {
    this.#repository = deps.repository;
    this.#logger = deps.logger.child({ domain: "organizations" });
  }

  async saveTenant(input: SaveTenantInput): Promise<Tenant> {
    const saved = await this.#repository.upsertTenant(tenantRow(input));
    this.#logger.info({ tenantId: saved.id, slug: saved.slug, status: saved.status }, "Tenant saved");
    return saved;
  }

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    const created = await this.#repository.insertTenant(tenantRow({ ...input, status: "active" }));
    if (created === null) {
      throw new AppError("conflict", `A tenant with the slug "${input.slug}" already exists.`, [
        { path: "slug", message: "Already taken. Choose another slug." },
      ]);
    }
    // Under its own key, so the caller's tenantId and userId on the line still say who did it.
    this.#logger.info({ tenant: { id: created.id, slug: created.slug, kind: created.kind } }, "Tenant created");
    return created;
  }

  async updateTenant(slug: string, changes: UpdateTenantInput): Promise<Tenant> {
    const fields: UpdateTenantInput = {};
    if (changes.name !== undefined) fields.name = validName(changes.name);
    if (changes.status !== undefined) fields.status = changes.status;
    if (changes.configuration !== undefined) fields.configuration = changes.configuration;
    if (Object.keys(fields).length === 0) {
      throw new AppError("invalid_input", "Nothing to change. Give the name, the status or the configuration.");
    }

    const updated = await this.#repository.updateTenant(slug, fields);
    if (updated === null) throw tenantNotFound(slug);
    this.#logger.info(
      { tenant: { id: updated.id, slug: updated.slug, status: updated.status }, changed: Object.keys(fields) },
      "Tenant updated",
    );
    return updated;
  }

  listTenants(): Promise<Tenant[]> {
    return this.#repository.listTenants();
  }

  getTenant(id: string): Promise<Tenant | null> {
    return this.#repository.findTenantById(id);
  }

  async getTenantBySlug(slug: string): Promise<Tenant> {
    const tenant = await this.#repository.findTenantBySlug(slug);
    if (tenant === null) throw tenantNotFound(slug);
    return tenant;
  }

  listUsers(tenantId: string): Promise<User[]> {
    return this.#repository.listUsers(tenantId);
  }

  async saveUser(input: SaveUserInput): Promise<User> {
    const saved = await this.#repository.upsertUser(await this.#userRow(input));
    this.#logger.info({ userId: saved.id, role: saved.role, tenantId: saved.tenantId }, "User saved");
    return saved;
  }

  async createUser(input: SaveUserInput): Promise<User> {
    const created = await this.#repository.insertUser(await this.#userRow(input));
    if (created === null) {
      throw new AppError("conflict", "A user with this email address already exists.", [
        { path: "email", message: "Already taken. One user per email address." },
      ]);
    }
    this.#logger.info({ user: { id: created.id, role: created.role, tenantId: created.tenantId } }, "User created");
    return created;
  }

  getMembership(userId: string): Promise<Membership | null> {
    return this.#repository.findMembership(userId);
  }

  async #userRow(input: SaveUserInput): Promise<UserRow> {
    // A client belongs to a tenant. A system admin operates the platform and belongs to none.
    let tenantId: string | null = null;
    if (input.role === "client") {
      if (input.tenantSlug === undefined) {
        throw new AppError("invalid_input", "A client must belong to a tenant.", [
          { path: "tenantSlug", message: "Required for a client." },
        ]);
      }
      tenantId = (await this.getTenantBySlug(input.tenantSlug)).id;
    } else if (input.tenantSlug !== undefined) {
      throw new AppError("invalid_input", "A system admin belongs to no tenant.", [
        { path: "tenantSlug", message: "Leave it out for a system admin." },
      ]);
    }
    return { name: validName(input.name), email: validEmail(input.email), role: input.role, tenantId };
  }
}

function tenantRow(input: SaveTenantInput): Required<SaveTenantInput> {
  if (input.slug.length > SLUG_MAX_LENGTH || !SLUG.test(input.slug)) {
    throw new AppError("invalid_input", "The tenant's slug is not valid.", [
      {
        path: "slug",
        message:
          `Use lowercase letters, digits and single hyphens, up to ${SLUG_MAX_LENGTH} characters, ` +
          "such as blue-travel.",
      },
    ]);
  }
  return {
    name: validName(input.name),
    slug: input.slug,
    kind: input.kind,
    status: input.status ?? "active",
    configuration: input.configuration ?? {},
  };
}

function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    throw new AppError("invalid_input", "The name is not valid.", [
      { path: "name", message: `Must be 1 to ${NAME_MAX_LENGTH} characters.` },
    ]);
  }
  return trimmed;
}

// Stored lower-cased, so one address is one user however it is written.
function validEmail(email: string): string {
  const normalised = email.trim().toLowerCase();
  if (normalised.length > EMAIL_MAX_LENGTH || !EMAIL.test(normalised)) {
    throw new AppError("invalid_input", "The email address is not valid.", [
      { path: "email", message: "Give an address such as ann@agency.example.com." },
    ]);
  }
  return normalised;
}

function tenantNotFound(slug: string): AppError {
  return new AppError("not_found", `There is no tenant with the slug "${slug}".`);
}
