import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Catalogue } from "../core/catalogue/ports.ts";
import { registerCatalogueTools } from "./tools/catalogue.ts";
import type { ToolDeps } from "./tool.ts";

export const MCP_SERVER_NAME = "magic-events";

// A fresh MCP server for one request, with the tools bound to the caller of that request.
export function createMcpServer(deps: ToolDeps, services: { catalogue: Catalogue }): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: "magic-events experience feed", version: "1.0.0" },
    {
      instructions:
        "Find what is on near a place while a traveller is there: festivals, concerts, matches, markets, shows, " +
        "exhibitions and seasons such as whale season. Use search_experiences with a point, a radius and the dates.",
    },
  );
  registerCatalogueTools(server, deps, services.catalogue);
  return server;
}
