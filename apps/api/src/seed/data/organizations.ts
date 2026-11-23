import type { CallerKind } from "../../core/identity/ports.ts";
import type { SaveTenantInput, SaveUserInput } from "../../core/organizations/ports.ts";

// The starting tenants, users and keys. Addresses are on example.com, which can never reach a real inbox.

export const tenants: SaveTenantInput[] = [
  { name: "Example Travel Agency", slug: "example-travel-agency", kind: "travel_agency", status: "active" },
  { name: "Example Travel App", slug: "example-travel-app", kind: "travel_app", status: "active" },
];

export interface SeedUser extends SaveUserInput {
  // The keys the user gets. A key is issued only when the user has no credential with that name yet.
  keys: { name: string; kind: CallerKind }[];
}

export const users: SeedUser[] = [
  {
    name: "Agency Planner",
    email: "planner@agency.example.com",
    role: "client",
    tenantSlug: "example-travel-agency",
    keys: [
      { name: "seed person key", kind: "person" },
      { name: "seed agent key", kind: "agent" },
    ],
  },
  {
    name: "App Planner",
    email: "planner@app.example.com",
    role: "client",
    tenantSlug: "example-travel-app",
    keys: [
      { name: "seed person key", kind: "person" },
      { name: "seed agent key", kind: "agent" },
    ],
  },
  {
    name: "System Admin",
    email: "admin@example.com",
    role: "system_admin",
    keys: [{ name: "seed person key", kind: "person" }],
  },
];
