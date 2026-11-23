// Organizations: the tenants and the people in them.
// It calls no other domain. Users, membership and roles are on Better Auth's user table, used directly.

export type TenantKind = "travel_agency" | "travel_app";
export type TenantStatus = "active" | "suspended";
export type Role = "system_admin" | "client";

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

// Inbound port: what Organizations offers.
export interface Organizations {
  // Creates the tenant, or updates the one that has this slug.
  saveTenant(input: SaveTenantInput): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | null>;
  // Creates the user, or updates the one that has this email address.
  saveUser(input: SaveUserInput): Promise<User>;
  // A user's role, tenant and the tenant's status. Identity reads this on every request.
  getMembership(userId: string): Promise<Membership | null>;
}

// Outbound port: what Organizations needs.
export interface OrganizationsRepository {
  upsertTenant(input: Required<SaveTenantInput>): Promise<Tenant>;
  findTenantById(id: string): Promise<Tenant | null>;
  findTenantBySlug(slug: string): Promise<Tenant | null>;
  upsertUser(input: { name: string; email: string; role: Role; tenantId: string | null }): Promise<User>;
  findMembership(userId: string): Promise<Membership | null>;
}
