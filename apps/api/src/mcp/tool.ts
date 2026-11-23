import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Action, Caller, Identity } from "../core/identity/ports.ts";
import { AppError } from "../core/shared/errors.ts";
import type { Logger } from "../core/shared/logger.ts";

// What every tool gets for the one request it answers.
export interface ToolDeps {
  caller: Caller;
  identity: Identity;
  logger: Logger;
}

export const TOOL_FAILED_MESSAGE =
  "Something went wrong on our side. Try again, and quote the x-request-id response header if you report it.";

// Registers a tool. When it is called, the caller's right to the tool's action is checked first, then the handler
// runs, and the answer is returned as structured content with the same JSON as text. Every failure becomes a tool
// error: an AppError keeps its message and details, and anything else is logged and gets a general message.
export function registerTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  deps: ToolDeps,
  tool: {
    name: string;
    action: Action;
    title: string;
    description: string;
    // False for a tool that changes something. A client may then ask before calling it. True when left out.
    readOnly?: boolean;
    inputSchema: I;
    outputSchema: O;
    handler: (input: z.infer<I>) => Promise<z.infer<O>>;
  },
): void {
  // Widened, because the SDK's callback type cannot be worked out for a generic schema.
  const inputSchema: z.ZodObject = tool.inputSchema;
  const outputSchema: z.ZodObject = tool.outputSchema;
  const readOnly = tool.readOnly ?? true;
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema,
      outputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: readOnly,
        // A tool that writes is taken to be destructive and not idempotent, the protocol's own defaults for it.
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        deps.identity.authorise(deps.caller, tool.action);
        // Checked here, so an answer that does not fit the schema is a system error and its details stay in the logs.
        // The SDK has already checked the arguments against the tool's input schema, so they are its output.
        const output: Record<string, unknown> = tool.outputSchema.parse(await tool.handler(input as z.infer<I>));
        deps.logger.debug({ tool: tool.name }, "Tool answered");
        return { structuredContent: output, content: [{ type: "text", text: JSON.stringify(output) }] };
      } catch (error) {
        return toolError(error, tool.name, deps.logger);
      }
    },
  );
}

export function toolError(error: unknown, toolName: string, logger: Logger): CallToolResult {
  if (error instanceof AppError) {
    logger.warn({ tool: toolName, code: error.code, reason: error.message }, "Tool call refused");
    const answer = { error: { code: error.code, message: error.message, details: error.details ?? [] } };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(answer) }] };
  }
  logger.error({ tool: toolName, err: error }, "Tool failed");
  const answer = { error: { code: "internal_error", message: TOOL_FAILED_MESSAGE, details: [] } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(answer) }] };
}
