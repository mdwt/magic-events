import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Catalogue } from "@magic-events/core/catalogue/ports.ts";
import type { Organizations } from "@magic-events/core/organizations/ports.ts";
import { registerCatalogueTools } from "./tools/catalogue.ts";
import { registerIdentityTools } from "./tools/identity.ts";
import { registerOrganizationsTools } from "./tools/organizations.ts";
import { answerToolCalls, type ToolDeps } from "./tool.ts";

export const MCP_SERVER_NAME = "magic-events";

// A fresh MCP server for one request, with the tools bound to the caller of that request.
export function createMcpServer(
  deps: ToolDeps,
  services: { catalogue: Catalogue; organizations: Organizations },
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: "magic-events experience feed", version: "1.0.0" },
    {
      instructions:
        "Find what is on near a place while a traveller is there: festivals, concerts, matches, markets, shows, " +
        "exhibitions and seasons such as whale season. Use search_experiences with the place and the dates: the " +
        "place is location, a location's slug such as hermanus, or near, a point, with a radius if you like. To " +
        "check back on a trip, use get_experience_changes with the same parameters and when you last searched. " +
        "A system admin onboards a travel agency or travel app with create_tenant, add_tenant_user and " +
        "issue_credential. When a call is refused, the tool error's text is JSON with a code, a message and details: " +
        "read the message and the details, fix each field the details name, and call again. A code of unavailable " +
        "means try again after a few seconds; internal_error means the fault is ours, so quote the requestId.",
    },
  );
  registerCatalogueTools(server, deps, services.catalogue);
  registerOrganizationsTools(server, deps, services.organizations);
  registerIdentityTools(server, deps);
  answerToolCalls(server, deps);
  return server;
}
