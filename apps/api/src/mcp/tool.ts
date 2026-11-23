import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Action, Caller, Identity } from "@magic-events/core/identity/ports.ts";
import { AppError, type ErrorDetail } from "@magic-events/core/shared/errors.ts";
import type { Logger } from "@magic-events/core/shared/logger.ts";
import { errorBody, MESSAGES, toErrorReply } from "../rest/errors.ts";

// What every tool gets for the one request it answers.
export interface ToolDeps {
  caller: Caller;
  identity: Identity;
  logger: Logger;
  // The request's ID, in every tool error, so the caller can quote it.
  requestId: string;
  // Whether a system error means the database cannot be reached, as over REST.
  isUnavailable: (error: unknown) => boolean;
}

interface RegisteredTool {
  action: Action;
  inputSchema: z.ZodObject;
  run: (input: Record<string, unknown>) => Promise<CallToolResult>;
}

const toolsOf = new WeakMap<McpServer, Map<string, RegisteredTool>>();

// Registers a tool. When it is called, the caller's right to the tool's action is checked first, then its arguments,
// then the handler runs, and the answer is returned as structured content with the same JSON as text. Every failure
// becomes a tool error in the REST API's error format: see answerToolCalls and toolError.
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
    // The SDK lists the tool; a call reaches it through answerToolCalls.
    (input) => run(input),
  );

  async function run(input: Record<string, unknown>): Promise<CallToolResult> {
    try {
      // Checked here, so an answer that does not fit the schema is a system error and its details stay in the logs.
      const output: Record<string, unknown> = tool.outputSchema.parse(await tool.handler(input as z.infer<I>));
      deps.logger.debug({ tool: tool.name }, "Tool answered");
      return { structuredContent: output, content: [{ type: "text", text: JSON.stringify(output) }] };
    } catch (error) {
      return toolError(error, tool.name, deps);
    }
  }

  let tools = toolsOf.get(server);
  if (tools === undefined) {
    tools = new Map();
    toolsOf.set(server, tools);
  }
  tools.set(tool.name, { action: tool.action, inputSchema, run });
}

// Answers tools/call in place of the SDK, once every tool is registered. The SDK checks a tool's arguments itself and
// words the failure its own way; here the caller's right to the tool comes first, as over REST, and arguments that
// do not fit are invalid_input with one detail per field, so an agent can correct its call.
export function answerToolCalls(server: McpServer, deps: ToolDeps): void {
  const tools = toolsOf.get(server) ?? new Map<string, RegisteredTool>();
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = tools.get(name);
    // A protocol error, as the protocol has it for a tool that does not exist.
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, `There is no tool named "${name}". tools/list lists them.`);
    try {
      deps.identity.authorise(deps.caller, tool.action);
    } catch (error) {
      return toolError(error, name, deps);
    }
    const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return toolError(new AppError("invalid_input", MESSAGES.invalidArguments, zodDetails(parsed.error)), name, deps);
    }
    return tool.run(parsed.data);
  });
}

// One detail per problem, named by its path, as the REST API gives for a body that does not fit.
function zodDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ path: path ? `${path}.${key}` : key, message: "Unknown field." }));
    }
    return [{ path, message: issue.message }];
  });
}

// A failure as a tool error, with the same code, message, details and request ID as the REST API would answer, as JSON
// text. A refused call is logged at warn with the reason, a system error at error in full.
export function toolError(
  error: unknown,
  toolName: string,
  deps: Pick<ToolDeps, "logger" | "requestId" | "isUnavailable">,
): CallToolResult {
  const answer = toErrorReply(error, deps.isUnavailable);
  if (answer.system) {
    deps.logger.error({ tool: toolName, code: answer.code, err: error }, "Tool failed");
  } else {
    deps.logger.warn({ tool: toolName, code: answer.code, reason: answer.message, details: answer.details }, "Tool call refused");
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify(errorBody(answer, deps.requestId)) }] };
}
