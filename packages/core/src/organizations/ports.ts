import { z } from "zod";

// Organizations: the tenants and the people in them.
// It calls no other domain. Users, membership and roles are on Better Auth's user table, used directly.

export const TENANT_KINDS = ["travel_agency", "travel_app"] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];
export const TENANT_STATUSES = ["active", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];
export const ROLES = ["system_admin", "client"] as const;
export type Role = (typeof ROLES)[number];

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  kind: TenantKind;
  status: TenantStatus;
  configuration: Record<string, unknown>;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Empty for a system admin, who belongs to no tenant.
  tenantId: string | null;
}

// A user with the role they hold and the tenant they belong to.
export interface Membership {
  user: User;
  tenant: Tenant | null;
}

export interface SaveTenantInput {
  name: string;
  slug: string;
  kind: TenantKind;
  status?: TenantStatus;
  configuration?: Record<string, unknown>;
}

export interface SaveUserInput {
  name: string;
  email: string;
  role: Role;
  // The slug of the user's tenant. Required for a client, and left out for a system admin.
  tenantSlug?: string;
}

// ---- Onboarding: what a system admin sends, over REST and MCP alike ----

const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .describe("The tenant's slug: lowercase letters, digits and single hyphens, such as blue-travel. It cannot be changed.");
const nameSchema = z.string().min(1).max(200);
const configurationSchema = z
  .record(z.string(), z.unknown())
  .describe("The tenant's configuration, as a JSON object. When it is given, it replaces the whole configuration.");

export const createTenantInputSchema = z.strictObject({
  name: nameSchema.describe("The tenant's name, such as Blue Travel."),
  slug: slugSchema,
  kind: z.enum(TENANT_KINDS).describe("What the tenant is: a travel agency or a travel app."),
  configuration: configurationSchema.optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantInputSchema>;

export const updateTenantInputSchema = z.strictObject({
  name: nameSchema.optional().describe("The tenant's new name."),
  status: z
    .enum(TENANT_STATUSES)
    .optional()
    .describe("active, or suspended to turn the tenant's access off: its users are refused until it is active again."),
  configuration: configurationSchema.optional(),
});
export type UpdateTenantInput = z.infer<typeof updateTenantInputSchema>;

export const tenantSlugParamsSchema = z.strictObject({ slug: slugSchema });

export const addTenantUserInputSchema = z.strictObject({
  name: nameSchema.describe("The person's name."),
  email: z.string().min(1).max(254).describe("The person's email address. One user per address."),
});
export type AddTenantUserInput = z.infer<typeof addTenantUserInputSchema>;

// ---- Onboarding: what is answered ----

export const tenantSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  kind: z.enum(TENANT_KINDS),
  status: z.enum(TENANT_STATUSES),
  configuration: z.record(z.string(), z.unknown()),
});

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  tenantId: z.uuid().nullable().describe("The user's tenant. Empty for a system admin."),
});

export const tenantWithUsersSchema = tenantSchema.extend({ users: z.array(userSchema) });

export const tenantListSchema = z.object({ items: z.array(tenantSchema) });

// Inbound port: what Organizations offers.
export interface Organizations {
  // Creates the tenant, or updates the one that has this slug. For the seed, which can be run again.
  saveTenant(input: SaveTenantInput): Promise<Tenant>;
  // Creates an active tenant. Fails with invalid_input when the slug is taken.
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  // Changes a tenant's name, status or configuration. Fails with not_found when there is no tenant with the slug.
  updateTenant(slug: string, changes: UpdateTenantInput): Promise<Tenant>;
  // Every tenant, by name.
  listTenants(): Promise<Tenant[]>;
  getTenant(id: string): Promise<Tenant | null>;
  // Fails with not_found when there is no tenant with the slug.
  getTenantBySlug(slug: string): Promise<Tenant>;
  // The users of one tenant, by name.
  listUsers(tenantId: string): Promise<User[]>;
  // Creates the user, or updates the one that has this email address. For the seed, which can be run again.
  saveUser(input: SaveUserInput): Promise<User>;
  // Creates the user. Fails with invalid_input when the email address is taken.
  createUser(input: SaveUserInput): Promise<User>;
  // A user's role, tenant and the tenant's status. Identity reads this on every request.
  getMembership(userId: string): Promise<Membership | null>;
}

// What the repository writes for a user.
export interface UserRow {
  name: string;
  email: string;
  role: Role;
  tenantId: string | null;
}

// Outbound port: what Organizations needs.
export interface OrganizationsRepository {
  upsertTenant(input: Required<SaveTenantInput>): Promise<Tenant>;
  // Null when a tenant with the slug already exists.
  insertTenant(input: Required<SaveTenantInput>): Promise<Tenant | null>;
  // Null when there is no tenant with the slug.
  updateTenant(slug: string, changes: UpdateTenantInput): Promise<Tenant | null>;
  listTenants(): Promise<Tenant[]>;
  findTenantById(id: string): Promise<Tenant | null>;
  findTenantBySlug(slug: string): Promise<Tenant | null>;
  listUsers(tenantId: string): Promise<User[]>;
  upsertUser(input: UserRow): Promise<User>;
  // Null when a user with the email address already exists.
  insertUser(input: UserRow): Promise<User | null>;
  findMembership(userId: string): Promise<Membership | null>;
}
