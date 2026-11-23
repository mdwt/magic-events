import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addTenantUserInputSchema,
  createTenantInputSchema,
  tenantListSchema,
  tenantSchema,
  tenantSlugParamsSchema,
  tenantWithUsersSchema,
  updateTenantInputSchema,
  userSchema,
  type Organizations,
} from "../../core/organizations/ports.ts";
import { registerTool, type ToolDeps } from "../tool.ts";

// Onboarding tenants and their users, as the REST API offers it. Every tool is listed for every caller, and only a
// system admin may call them: a client gets a forbidden tool error.

const ADMIN_ONLY = "For system admins only.";

export function registerOrganizationsTools(server: McpServer, deps: ToolDeps, organizations: Organizations): void {
  registerTool(server, deps, {
    name: "create_tenant",
    action: "tenants.manage",
    title: "Create a tenant",
    description:
      "Create a tenant, a travel agency or a travel app, as active, with its configuration. The slug is the tenant's " +
      `lasting name and must not be taken. Add its first user next, with add_tenant_user. ${ADMIN_ONLY}`,
    readOnly: false,
    inputSchema: createTenantInputSchema,
    outputSchema: tenantSchema,
    handler: (input) => organizations.createTenant(input),
  });

  registerTool(server, deps, {
    name: "list_tenants",
    action: "tenants.manage",
    title: "List tenants",
    description: `Every tenant, by name, with its kind, status and configuration. ${ADMIN_ONLY}`,
    inputSchema: z.strictObject({}),
    outputSchema: tenantListSchema,
    handler: async () => ({ items: await organizations.listTenants() }),
  });

  registerTool(server, deps, {
    name: "get_tenant",
    action: "tenants.manage",
    title: "Get a tenant",
    description: `One tenant, by its slug, with its users. ${ADMIN_ONLY}`,
    inputSchema: tenantSlugParamsSchema,
    outputSchema: tenantWithUsersSchema,
    handler: async ({ slug }) => {
      const tenant = await organizations.getTenantBySlug(slug);
      return { ...tenant, users: await organizations.listUsers(tenant.id) };
    },
  });

  registerTool(server, deps, {
    name: "update_tenant",
    action: "tenants.manage",
    title: "Change a tenant",
    description:
      "Change a tenant's name, status or configuration, by its slug; what is left out stays as it is. Setting the " +
      `status to suspended turns the tenant's access off until it is active again. ${ADMIN_ONLY}`,
    readOnly: false,
    inputSchema: tenantSlugParamsSchema.extend(updateTenantInputSchema.shape),
    outputSchema: tenantSchema,
    handler: ({ slug, ...changes }) => organizations.updateTenant(slug, changes),
  });

  registerTool(server, deps, {
    name: "add_tenant_user",
    action: "tenants.manage",
    title: "Add a user to a tenant",
    description:
      "Add a person to a tenant, by its slug, with the client role. The email address must not belong to another " +
      `user. Issue the user's API keys next, with issue_credential. ${ADMIN_ONLY}`,
    readOnly: false,
    inputSchema: tenantSlugParamsSchema.extend(addTenantUserInputSchema.shape),
    outputSchema: userSchema,
    handler: ({ slug, ...user }) => organizations.createUser({ ...user, role: "client", tenantSlug: slug }),
  });
}
