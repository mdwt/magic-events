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

// A tool's whole answer to one call: the caller's right to its action, then its arguments, then the handler, then
// the answer checked against the output schema. Every failure is a tool error, never a thrown one.
type ToolCall = (args: unknown) => Promise<CallToolResult>;

const toolsOf = new WeakMap<McpServer, Map<string, ToolCall>>();

// Registers a tool that only reads. Its answer is structured content with the same JSON as text, as the protocol
// asks of a tool with an output schema; every failure is a tool error in the REST API's error format.
export function registerTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  deps: ToolDeps,
  tool: {
    name: string;
    action: Action;
    title: string;
    description: string;
    inputSchema: I;
    outputSchema: O;
    handler: (input: z.infer<I>) => Promise<z.infer<O>>;
  },
): void {
  // Widened, because the SDK's callback type cannot be worked out for a generic schema.
  const inputSchema: z.ZodObject = tool.inputSchema;
  const outputSchema: z.ZodObject = tool.outputSchema;

  const call: ToolCall = async (args) => {
    // Who called which tool with which arguments: the log context adds the caller, and no argument is a secret.
    deps.logger.info({ tool: tool.name, arguments: args }, "Tool called");
    try {
      deps.identity.authorise(deps.caller, tool.action);
      const parsed = inputSchema.safeParse(args ?? {});
      if (!parsed.success) throw new AppError("invalid_input", MESSAGES.invalidArguments, zodDetails(parsed.error));
      // Checked here, so an answer that does not fit the schema is a system error and its details stay in the logs.
      const output: Record<string, unknown> = outputSchema.parse(await tool.handler(parsed.data as z.infer<I>));
      return { structuredContent: output, content: [{ type: "text", text: JSON.stringify(output) }] };
    } catch (error) {
      return toolError(error, tool.name, deps);
    }
  };

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema,
      outputSchema,
      annotations: {
        // For clients on the 2025-03-26 revision, which read the title here.
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // The answers carry text copied from third-party websites, so a client should treat them as from the open web.
        openWorldHint: true,
      },
    },
    // answerToolCalls answers tools/call. Were the SDK's own handler ever to run instead, the call still goes
    // through the caller's right to the tool.
    (input) => call(input),
  );

  let tools = toolsOf.get(server);
  if (tools === undefined) {
    tools = new Map();
    toolsOf.set(server, tools);
  }
  tools.set(tool.name, call);
}

// Answers tools/call in place of the SDK's handler, once every tool is registered. The SDK checks a tool's arguments
// before the caller's right to the tool, and words a failure as one line of its own; here the right comes first, as
// over REST, and arguments that do not fit are invalid_input with one detail per field, so an agent can correct its
// call. The tools are stateless reads that answer in one go, so the SDK's tasks, progress and cancellation have
// nothing to act on.
export function answerToolCalls(server: McpServer): void {
  const tools = toolsOf.get(server) ?? new Map<string, ToolCall>();
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const name = request.params.name;
    const call = tools.get(name);
    // A protocol error, as the protocol has it for a tool that does not exist.
    if (call === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `There is no tool named "${name}". tools/list lists the tools.`);
    }
    return call(request.params.arguments);
  });
  // The tools never change while a server answers its one request, and a stateless server has no stream to announce
  // a change on, so the list is declared as not changing.
  server.server.registerCapabilities({ tools: { listChanged: false } });
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
