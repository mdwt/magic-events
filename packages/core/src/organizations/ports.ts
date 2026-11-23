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

// What a system admin gives to create a tenant. It is created active.
export interface CreateTenantInput {
  name: string;
  slug: string;
  kind: TenantKind;
  configuration?: Record<string, unknown>;
}

// What a system admin changes on a tenant; what is left out stays as it is. A configuration replaces the whole one,
// and suspended turns the tenant's access off until it is active again.
export interface UpdateTenantInput {
  name?: string;
  status?: TenantStatus;
  configuration?: Record<string, unknown>;
}

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
  // Fails with not_found when there is no user with the email address, however it is written.
  getUserByEmail(email: string): Promise<User>;
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
  // The email address as it is stored, lower-cased.
  findUserByEmail(email: string): Promise<User | null>;
  upsertUser(input: UserRow): Promise<User>;
  // Null when a user with the email address already exists.
  insertUser(input: UserRow): Promise<User | null>;
  findMembership(userId: string): Promise<Membership | null>;
}
