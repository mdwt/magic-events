import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  credentialListSchema,
  credentialParamsSchema,
  credentialSummarySchema,
  issueCredentialInputSchema,
  issuedCredentialSchema,
  userIdParamsSchema,
} from "../../core/identity/ports.ts";
import { registerTool, type ToolDeps } from "../tool.ts";

// Issuing, listing and revoking a user's API keys, as the REST API offers it. Listed for every caller, and only a
// system admin may call them: a client gets a forbidden tool error.

const ADMIN_ONLY = "For system admins only.";

export function registerIdentityTools(server: McpServer, deps: ToolDeps): void {
  const { identity } = deps;

  registerTool(server, deps, {
    name: "issue_credential",
    action: "tenants.manage",
    title: "Issue an API key",
    description:
      "Issue an API key for a user, for the REST API and MCP alike, used by a person or by an AI agent acting for " +
      "them. The key is in this answer only: it is stored as a hash and cannot be read again, so hand it over now. " +
      ADMIN_ONLY,
    readOnly: false,
    inputSchema: userIdParamsSchema.extend(issueCredentialInputSchema.shape),
    outputSchema: issuedCredentialSchema,
    handler: (input) => identity.issueCredential(input),
  });

  registerTool(server, deps, {
    name: "list_credentials",
    action: "tenants.manage",
    title: "List a user's API keys",
    description:
      `A user's credentials, with their names, who uses them and whether they are enabled. Never the keys. ` +
      ADMIN_ONLY,
    inputSchema: userIdParamsSchema,
    outputSchema: credentialListSchema,
    handler: async ({ userId }) => ({ items: await identity.listCredentials(userId) }),
  });

  registerTool(server, deps, {
    name: "revoke_credential",
    action: "tenants.manage",
    title: "Revoke an API key",
    description: `Disable one of a user's API keys: every call with it is refused from then on. ${ADMIN_ONLY}`,
    readOnly: false,
    inputSchema: credentialParamsSchema,
    outputSchema: credentialSummarySchema,
    handler: ({ userId, credentialId }) => identity.revokeCredential(userId, credentialId),
  });
}
