import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  Membership,
  Organizations,
  OrganizationsRepository,
  SaveTenantInput,
  SaveUserInput,
  Tenant,
  User,
} from "./ports.ts";

export class OrganizationsService implements Organizations {
  readonly #repository: OrganizationsRepository;
  readonly #logger: Logger;

  constructor(deps: { repository: OrganizationsRepository; logger: Logger }) {
    this.#repository = deps.repository;
    this.#logger = deps.logger.child({ domain: "organizations" });
  }

  async saveTenant(input: SaveTenantInput): Promise<Tenant> {
    const saved = await this.#repository.upsertTenant({
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      status: input.status ?? "active",
      configuration: input.configuration ?? {},
    });
    this.#logger.info({ tenantId: saved.id, slug: saved.slug, status: saved.status }, "Tenant saved");
    return saved;
  }

  getTenant(id: string): Promise<Tenant | null> {
    return this.#repository.findTenantById(id);
  }

  async saveUser(input: SaveUserInput): Promise<User> {
    // A client belongs to a tenant. A system admin operates the platform and belongs to none.
    let tenantId: string | null = null;
    if (input.role === "client") {
      if (input.tenantSlug === undefined) {
        throw new AppError("invalid_input", "A client must belong to a tenant.", [
          { path: "tenantSlug", message: "Required for a client." },
        ]);
      }
      const tenant = await this.#repository.findTenantBySlug(input.tenantSlug);
      if (!tenant) throw new AppError("not_found", `There is no tenant with the slug "${input.tenantSlug}".`);
      tenantId = tenant.id;
    } else if (input.tenantSlug !== undefined) {
      throw new AppError("invalid_input", "A system admin belongs to no tenant.", [
        { path: "tenantSlug", message: "Leave it out for a system admin." },
      ]);
    }

    const saved = await this.#repository.upsertUser({
      name: input.name,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      tenantId,
    });
    this.#logger.info({ userId: saved.id, role: saved.role, tenantId: saved.tenantId }, "User saved");
    return saved;
  }

  getMembership(userId: string): Promise<Membership | null> {
    return this.#repository.findMembership(userId);
  }
}
