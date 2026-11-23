# Web App: Tenant Dashboard with an MCP Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/web` becomes a tenant dashboard whose one page is a chat where an AI agent uses the feed through MCP, authenticated with a tenant API key from an environment variable, and shows every tool call.

**Architecture:** A shadcn sidebar shell wraps one page, `/chat`. The page's client component uses `useChat` against `POST /api/chat`. That route handler opens an MCP client to the feed with the tenant's key, hands the feed's tools to `streamText` with Claude, and streams UI messages back. Everything that decides something (settings, error bodies, the MCP connection, the tool-call view) is a small module under `src/lib/chat/` with `node:test` tests; the route and the components only wire them.

**Tech Stack:** Next.js 16.4.6, React 19.3, Tailwind 4.3.5, shadcn/ui 4.23 (Base UI), shadcn AI Elements patterns, AI SDK 7 (`ai` 7.0.x, `@ai-sdk/react` 4.0.x, `@ai-sdk/mcp` 2.0.x, `@ai-sdk/anthropic` 4.0.x), Streamdown, `node:test`.

**Spec:** [docs/superpowers/specs/2026-11-23-web-mcp-chat-design.md](../specs/2026-11-23-web-mcp-chat-design.md)

## Global Constraints

- All work is in `apps/web`, plus the root `.env.example` and `pnpm-lock.yaml`. Nothing under `apps/api` or `packages/db` is touched.
- Another session has uncommitted work in this worktree. Never `git add -A` or `git commit -a`. Commit by explicit path: `git add <paths>` then `git commit -m "..." -- <paths>`. Retry on `index.lock`; never delete it.
- Every commit message ends with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- `apps/web/AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing Next.js code.
- Never write AI SDK code from memory. After install, read `apps/web/node_modules/ai/docs/` (`02-getting-started/02-nextjs-app-router.mdx`, `03-ai-sdk-core/16-mcp-tools.mdx`, `04-ai-sdk-ui/03-chatbot-tool-usage.mdx`, `04-ai-sdk-ui/21-error-handling.mdx`) and follow them.
- AI Elements come from shadcn/ui (`https://ui.shadcn.com/docs/ai-elements.md`, and `/docs/ai-elements/base/<chat|message|tool|prompt-input>.md`). The `ai-elements` npm CLI is deprecated at the end of November 2026; do not use it.
- Add dependencies with `pnpm --filter @magic-events/web add <pkg>`. Run shadcn with `pnpm dlx shadcn@latest <command>` from `apps/web`.
- The tenant API key and the Anthropic key are server only: no `NEXT_PUBLIC_` name, never in a response body, never logged.
- Settings, exact names and defaults: `MAGIC_EVENTS_API_KEY` (none), `MAGIC_EVENTS_MCP_URL` (`http://localhost:4000/mcp`), `ANTHROPIC_API_KEY` (none).
- The model id is `claude-sonnet-5-5`, defined once.
- Modules under `src/lib/chat/` import each other by relative path with the `.ts` extension, so `node --test` runs them without a build step. They use no `enum` and no parameter properties.
- After every task: `pnpm --filter @magic-events/web lint`, `typecheck`, `test` and `build` all pass.

## Review Focus

1. **A setting is missing** (`MAGIC_EVENTS_API_KEY` or `ANTHROPIC_API_KEY` unset or blank). The chat names the missing setting; it does not show a generic failure. Tested in Task 2 (`readChatSettings`).
2. **The feed is reachable but rejects the key** (401 or 403). The chat says the key was rejected, which is a different message from "not reachable". Tested in Task 2 (`classifyMcpError`, `connectFeed`).
3. **The feed is reachable and offers no tools.** The chat says so; it does not run a chat without tools. Tested in Task 2 (`connectFeed`).
4. **A tool call fails**, either as an `output-error` part or as an MCP result with `isError: true` (which the MCP client returns as ordinary output). It is shown as failed with the error text, never as done. Tested in Task 3 (`toolCallView`).
5. **A tool returns a very large output** (hundreds of experiences). The output block scrolls inside a fixed height and the conversation stays usable. Checked in Task 3, step 7.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/web/components.json`, `src/components/ui/*`, `src/lib/utils.ts` | Written by the shadcn CLI |
| `apps/web/next.config.ts` | Also loads the root `.env` |
| `src/app/layout.tsx` | Root layout: fonts, metadata, providers the shadcn components need |
| `src/app/page.tsx` | Redirects `/` to `/chat` |
| `src/app/(dashboard)/layout.tsx` | The dashboard shell: sidebar, header, page area |
| `src/components/app-sidebar.tsx` | The sidebar: product name and the navigation |
| `src/app/(dashboard)/chat/page.tsx` | The chat page |
| `src/lib/chat/settings.ts` | Reads and validates the three settings; holds the model id |
| `src/lib/chat/errors.ts` | The error body the route answers with and the chat reads |
| `src/lib/chat/feed.ts` | Opens the MCP client and gets the feed's tools |
| `src/app/api/chat/route.ts` | `POST /api/chat` |
| `src/lib/chat/tool-view.ts` | Turns a tool part into what the chat shows |
| `src/components/markdown.tsx` | Renders a streamed reply with Streamdown |
| `src/components/chat/chat.tsx` | `useChat`, the thread, the prompt input |
| `src/components/chat/chat-message.tsx` | One turn: bubble, reply, tool calls |
| `src/components/chat/tool-call.tsx` | One tool call as a Trace line |
| `src/components/chat/chat-error.tsx` | The error state |
| `apps/web/test/chat/*.test.ts` | `node:test` tests for `src/lib/chat/` |

---

### Task 1: shadcn/ui and the dashboard shell

**Files:**
- Create: `apps/web/components.json`, `apps/web/src/lib/utils.ts`, `apps/web/src/components/ui/*` (CLI output)
- Create: `apps/web/src/app/(dashboard)/layout.tsx`, `apps/web/src/app/(dashboard)/chat/page.tsx`, `apps/web/src/components/app-sidebar.tsx`
- Modify: `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/globals.css` (CLI), `apps/web/package.json`, `pnpm-lock.yaml`
- Delete: `apps/web/public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`

**Interfaces:**
- Produces: the route `/chat` inside the dashboard shell; `AppSidebar` (no props) exported from `@/components/app-sidebar`; shadcn components importable from `@/components/ui/*`.

- [ ] **Step 1: Check the lockfile is clean.** Run `git status --short pnpm-lock.yaml apps/web`. Expected: no output. If `pnpm-lock.yaml` is modified, stop and report: the other session has a dependency change in progress.

- [ ] **Step 2: Initialise shadcn.** Read `pnpm dlx shadcn@latest init --help`. From `apps/web`, initialise into the existing project: component library `base` (Base UI, which the AI Elements pages are written for), the default preset, CSS variables on, no monorepo scaffold. The project has no PostCSS or Tailwind config file: Tailwind 4 is loaded by the `@tailwindcss/turbopack` rule in `next.config.ts` and `@import "tailwindcss"` in `src/app/globals.css`. If the CLI cannot detect Tailwind, write `components.json` by hand for Tailwind 4 (`tailwind.config` empty, `tailwind.css` `src/app/globals.css`, aliases under `@/`) and re-run with it in place. Do not add a PostCSS config.

- [ ] **Step 3: Add the shell components.** `pnpm dlx shadcn@latest add sidebar` (it brings its own dependencies).

- [ ] **Step 4: Build the shell.**
  - `src/components/app-sidebar.tsx`: a shadcn `Sidebar` with a header showing "Magic Events" and one navigation group with one item, "Chat", linking to `/chat` and marked active on that path.
  - `src/app/(dashboard)/layout.tsx`: `SidebarProvider`, `AppSidebar`, and a `SidebarInset` holding a header (the `SidebarTrigger` and the page title) and the page area, which fills the remaining height so the chat can scroll inside it.
  - `src/app/(dashboard)/chat/page.tsx`: for now, the heading "Chat" only. Task 3 replaces it.
  - `src/app/page.tsx`: `redirect("/chat")`.
  - `src/app/layout.tsx`: metadata title "Magic Events", description "A feed of experiences by location, for the people and agents planning trips."; keep the Geist fonts; add whatever provider the installed shadcn components document as required at the root.
  - Delete the five create-next-app SVGs in `public/`.

- [ ] **Step 5: Verify.** Run `pnpm --filter @magic-events/web lint && pnpm --filter @magic-events/web typecheck && pnpm --filter @magic-events/web build`. Expected: all pass. Then `pnpm --filter @magic-events/web dev`, and `curl -sI http://localhost:3000/` shows a redirect to `/chat`, and `curl -s http://localhost:3000/chat` contains `Magic Events` and `Chat`. Open `/chat` in a browser: the sidebar collapses and expands, and light and dark both render.

- [ ] **Step 6: Commit.** Paths: `apps/web` and `pnpm-lock.yaml`. Message: `Web: shadcn/ui and the dashboard shell`.

---

### Task 2: The chat route

**Files:**
- Create: `apps/web/src/lib/chat/settings.ts`, `errors.ts`, `feed.ts`
- Create: `apps/web/src/app/api/chat/route.ts`
- Create: `apps/web/test/chat/settings.test.ts`, `errors.test.ts`, `feed.test.ts`
- Modify: `apps/web/next.config.ts`, `apps/web/tsconfig.json` (`allowImportingTsExtensions: true`), `apps/web/package.json` (dependencies; `"test": "node --test \"test/**/*.test.ts\""`), `apps/web/README.md`, `.env.example`, `pnpm-lock.yaml`

**Interfaces:**
- Produces, from `src/lib/chat/settings.ts`:
  ```ts
  export const DEFAULT_MCP_URL = "http://localhost:4000/mcp";
  export const CHAT_MODEL = "claude-sonnet-5-5";
  export interface ChatSettings { apiKey: string; mcpUrl: string; anthropicApiKey: string }
  export type ChatSettingsResult = { ok: true; settings: ChatSettings } | { ok: false; missing: string[] };
  export function readChatSettings(env: Record<string, string | undefined>): ChatSettingsResult;
  ```
- Produces, from `src/lib/chat/errors.ts`:
  ```ts
  export type ChatErrorCode = "not_configured" | "mcp_unreachable" | "mcp_unauthorized" | "mcp_no_tools";
  export interface ChatErrorBody { code: ChatErrorCode; message: string; mcpUrl?: string; missing?: string[] }
  export function chatErrorResponse(body: ChatErrorBody): Response;            // JSON; 500 for not_configured, 502 for the rest
  export function classifyMcpError(error: unknown): "mcp_unreachable" | "mcp_unauthorized";
  export function parseChatError(responseBody: string | undefined): ChatErrorBody | null;
  ```
- Produces, from `src/lib/chat/feed.ts`:
  ```ts
  export interface FeedClient { tools(): Promise<Record<string, unknown>>; close(): Promise<void> }
  export type ConnectFeed = (options: { url: string; apiKey: string }) => Promise<FeedClient>;
  export type FeedResult =
    | { ok: true; client: FeedClient; tools: Record<string, unknown> }
    | { ok: false; error: ChatErrorBody };
  export function openFeed(settings: ChatSettings, connect?: ConnectFeed): Promise<FeedResult>;
  ```
  The default `connect` is `createMCPClient` from `@ai-sdk/mcp` with `transport: { type: "http", url, headers: { Authorization: "Bearer <apiKey>" } }`. Narrow the tools type to the AI SDK's own tool set type once the package is installed.
- Produces: `POST /api/chat`, body `{ messages: UIMessage[] }`, answering a UI message stream, or a `ChatErrorBody` as JSON with a non-2xx status.

- [ ] **Step 1: Install.** `pnpm --filter @magic-events/web add ai @ai-sdk/mcp @ai-sdk/anthropic zod`. Then read the four AI SDK docs named in Global Constraints.

- [ ] **Step 2: Write the failing tests.**

  `test/chat/settings.test.ts`:
  ```ts
  test("reads the three settings", () => {
    assert.deepEqual(
      readChatSettings({ MAGIC_EVENTS_API_KEY: "k", MAGIC_EVENTS_MCP_URL: "http://feed/mcp", ANTHROPIC_API_KEY: "a" }),
      { ok: true, settings: { apiKey: "k", mcpUrl: "http://feed/mcp", anthropicApiKey: "a" } },
    );
  });
  test("the MCP URL defaults to the local API", () => {
    const result = readChatSettings({ MAGIC_EVENTS_API_KEY: "k", ANTHROPIC_API_KEY: "a" });
    assert.equal(result.ok && result.settings.mcpUrl, "http://localhost:4000/mcp");
  });
  test("names every missing setting, and blank counts as missing", () => {
    assert.deepEqual(readChatSettings({ MAGIC_EVENTS_API_KEY: "  " }), {
      ok: false,
      missing: ["MAGIC_EVENTS_API_KEY", "ANTHROPIC_API_KEY"],
    });
  });
  ```

  `test/chat/errors.test.ts`:
  ```ts
  test("not_configured answers 500, the MCP errors answer 502", async () => {
    assert.equal(chatErrorResponse({ code: "not_configured", message: "m", missing: ["X"] }).status, 500);
    for (const code of ["mcp_unreachable", "mcp_unauthorized", "mcp_no_tools"] as const) {
      assert.equal(chatErrorResponse({ code, message: "m" }).status, 502);
    }
  });
  test("the body round-trips through parseChatError", async () => {
    const body = { code: "mcp_unreachable" as const, message: "m", mcpUrl: "http://feed/mcp" };
    assert.deepEqual(parseChatError(await chatErrorResponse(body).text()), body);
  });
  test("parseChatError answers null for anything that is not an error body", () => {
    assert.equal(parseChatError(undefined), null);
    assert.equal(parseChatError("<html>"), null);
    assert.equal(parseChatError(JSON.stringify({ code: "something_else", message: "m" })), null);
  });
  test("401 and 403 mean the key was rejected, anything else means not reachable", () => {
    assert.equal(classifyMcpError({ statusCode: 401 }), "mcp_unauthorized");
    assert.equal(classifyMcpError({ statusCode: 403 }), "mcp_unauthorized");
    assert.equal(classifyMcpError(new Error("wrapped", { cause: { statusCode: 401 } })), "mcp_unauthorized");
    assert.equal(classifyMcpError({ statusCode: 503 }), "mcp_unreachable");
    assert.equal(classifyMcpError(new TypeError("fetch failed")), "mcp_unreachable");
    assert.equal(classifyMcpError(undefined), "mcp_unreachable");
  });
  ```

  `test/chat/feed.test.ts`, with `settings = { apiKey: "secret-key", mcpUrl: "http://feed/mcp", anthropicApiKey: "a" }`:
  ```ts
  test("connects with the URL and the key, and returns the client and its tools", async () => {
    const seen: unknown[] = [];
    const client = { tools: async () => ({ search: {} }), close: async () => {} };
    const result = await openFeed(settings, async (options) => { seen.push(options); return client; });
    assert.deepEqual(seen, [{ url: "http://feed/mcp", apiKey: "secret-key" }]);
    assert.deepEqual(result, { ok: true, client, tools: { search: {} } });
  });
  test("a feed that cannot be reached is mcp_unreachable, with the URL tried", async () => {
    const result = await openFeed(settings, async () => { throw new TypeError("fetch failed"); });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "mcp_unreachable");
    assert.equal(!result.ok && result.error.mcpUrl, "http://feed/mcp");
  });
  test("a feed that rejects the key is mcp_unauthorized", async () => {
    const result = await openFeed(settings, async () => { throw { statusCode: 401 }; });
    assert.equal(!result.ok && result.error.code, "mcp_unauthorized");
  });
  test("a failure while listing tools is classified the same way, and the client is closed", async () => {
    let closed = 0;
    const client = { tools: async () => { throw { statusCode: 401 }; }, close: async () => { closed += 1; } };
    const result = await openFeed(settings, async () => client);
    assert.equal(!result.ok && result.error.code, "mcp_unauthorized");
    assert.equal(closed, 1);
  });
  test("a feed with no tools is mcp_no_tools, and the client is closed", async () => {
    let closed = 0;
    const client = { tools: async () => ({}), close: async () => { closed += 1; } };
    const result = await openFeed(settings, async () => client);
    assert.equal(!result.ok && result.error.code, "mcp_no_tools");
    assert.equal(closed, 1);
  });
  test("no error body carries the key", async () => {
    for (const failure of [new TypeError("fetch failed secret-key"), { statusCode: 401 }]) {
      const result = await openFeed(settings, async () => { throw failure; });
      assert.equal(JSON.stringify(result).includes("secret-key"), false);
    }
  });
  ```

- [ ] **Step 3: Run the tests.** `pnpm --filter @magic-events/web test`. Expected: FAIL, the modules do not exist.

- [ ] **Step 4: Implement `settings.ts`, `errors.ts` and `feed.ts`** to the interfaces above. Error messages, exact copy:
  - `not_configured`: `Missing settings: <names, comma separated>. Set them in the root .env and restart the web app.`
  - `mcp_unreachable`: `The feed's MCP endpoint is not reachable at <mcpUrl>.`
  - `mcp_unauthorized`: `The feed rejected the API key in MAGIC_EVENTS_API_KEY.`
  - `mcp_no_tools`: `The feed's MCP endpoint at <mcpUrl> offers no tools.`

  The messages are written by this code only; the caught error's own message is never copied into a body.

- [ ] **Step 5: Run the tests.** `pnpm --filter @magic-events/web test`. Expected: PASS.

- [ ] **Step 6: Load the root `.env`.** In `next.config.ts`, before the config object, call Node's built-in `process.loadEnvFile` on `../../.env` resolved from the config file's own directory, ignoring a missing file. It does not override a variable that is already set, so a value in the shell wins.

- [ ] **Step 7: Implement `src/app/api/chat/route.ts`.** Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` first. `POST`:
  1. `readChatSettings(process.env)`; when not ok, `chatErrorResponse` with `not_configured` and `missing`.
  2. `openFeed(settings)`; when not ok, `chatErrorResponse(result.error)`.
  3. `streamText` with the Anthropic provider built from `settings.anthropicApiKey`, `CHAT_MODEL`, the feed's tools, the converted messages, `stopWhen: isStepCount(20)`, and this system prompt, exact copy: `You are a travel planner's assistant. Answer questions about what is on in a place by using the feed's tools. Say plainly when the feed returns nothing.`
  4. Close the MCP client when the stream ends, and also when it errors or is aborted, using the callbacks the installed docs name for each.
  5. Answer the UI message stream the way the installed quickstart does.

- [ ] **Step 8: Document the settings.**
  - Root `.env.example`: append `MAGIC_EVENTS_API_KEY=`, `MAGIC_EVENTS_MCP_URL=http://localhost:4000/mcp`, `ANTHROPIC_API_KEY=`.
  - `apps/web/README.md`: replace the create-next-app text with what the app is (one paragraph from the spec's Intent), the settings table from the spec, and how to run it (`pnpm --filter @magic-events/web dev`, then `/chat`; the tenant key comes from `pnpm db:seed`).

- [ ] **Step 9: Verify against the running app.** `pnpm --filter @magic-events/web lint`, `typecheck`, `test`, `build`: all pass. Then, with nothing listening on port 4999:
  ```bash
  MAGIC_EVENTS_API_KEY= pnpm --filter @magic-events/web dev   # in one terminal
  curl -s -w "\n%{http_code}\n" -X POST localhost:3000/api/chat -H 'content-type: application/json' -d '{"messages":[]}'
  ```
  Expected: `500` and a body with `"code":"not_configured"` and `MAGIC_EVENTS_API_KEY` in `missing`. Restart with `MAGIC_EVENTS_API_KEY=test-key MAGIC_EVENTS_MCP_URL=http://localhost:4999/mcp` and repeat the `curl`. Expected: `502`, `"code":"mcp_unreachable"`, `"mcpUrl":"http://localhost:4999/mcp"`, and no `test-key` anywhere in the body. This also proves the root `.env` is loaded: `ANTHROPIC_API_KEY` is not reported missing.

- [ ] **Step 10: Commit.** `.env.example` holds another session's uncommitted line, so stage only the three new lines:
  ```bash
  blob=$( (git show HEAD:.env.example; printf 'MAGIC_EVENTS_API_KEY=\nMAGIC_EVENTS_MCP_URL=http://localhost:4000/mcp\nANTHROPIC_API_KEY=\n') | git hash-object -w --stdin )
  git update-index --cacheinfo 100644,$blob,.env.example
  git add apps/web pnpm-lock.yaml
  git diff --cached --name-only        # expected: .env.example, pnpm-lock.yaml and apps/web paths only
  git commit -m "Web: chat route that runs Claude with the feed's MCP tools"
  ```
  This one commit has no pathspec because a pathspec would take the whole working-tree `.env.example`. If `git diff --cached --name-only` lists anything else, unstage it first.

---

### Task 3: The chat

**Files:**
- Create: `apps/web/src/lib/chat/tool-view.ts`, `apps/web/test/chat/tool-view.test.ts`
- Create: `apps/web/src/components/markdown.tsx`, `apps/web/src/components/chat/chat.tsx`, `chat-message.tsx`, `tool-call.tsx`, `chat-error.tsx`
- Create: `apps/web/src/components/ui/*` (CLI output)
- Modify: `apps/web/src/app/(dashboard)/chat/page.tsx`, `apps/web/package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `POST /api/chat` and `parseChatError`, `ChatErrorBody` from Task 2.
- Produces, from `src/lib/chat/tool-view.ts`:
  ```ts
  export type ToolCallStatus = "running" | "done" | "failed";
  export interface ToolCallView { name: string; status: ToolCallStatus; input: string | null; output: string | null; error: string | null }
  export interface ToolPartLike { type: string; toolName?: string; state: string; input?: unknown; output?: unknown; errorText?: string }
  export function isToolPart(part: { type: string }): boolean;        // "dynamic-tool" or "tool-<name>"
  export function toolCallView(part: ToolPartLike): ToolCallView;
  ```

- [ ] **Step 1: Install.** `pnpm --filter @magic-events/web add @ai-sdk/react streamdown`, then `pnpm dlx shadcn@latest add message-scroller message bubble input-group trace code-block empty` from `apps/web`. Read the four shadcn AI Elements pages named in Global Constraints, and `https://ui.shadcn.com/docs/components/base/code-block.md` for its Markdown section.

- [ ] **Step 2: Write the failing test.** `test/chat/tool-view.test.ts`:
  ```ts
  test("a dynamic tool part takes its name from toolName, a static one from its type", () => {
    assert.equal(toolCallView({ type: "dynamic-tool", toolName: "search_experiences", state: "input-available" }).name, "search_experiences");
    assert.equal(toolCallView({ type: "tool-search_experiences", state: "input-available" }).name, "search_experiences");
  });
  test("isToolPart", () => {
    assert.equal(isToolPart({ type: "dynamic-tool" }), true);
    assert.equal(isToolPart({ type: "tool-search" }), true);
    assert.equal(isToolPart({ type: "text" }), false);
  });
  test("a call without output yet is running, and shows its input", () => {
    assert.deepEqual(toolCallView({ type: "dynamic-tool", toolName: "t", state: "input-available", input: { place: "Hermanus" } }), {
      name: "t", status: "running", input: '{\n  "place": "Hermanus"\n}', output: null, error: null,
    });
    assert.equal(toolCallView({ type: "dynamic-tool", toolName: "t", state: "input-streaming" }).input, null);
  });
  test("a call with output is done, and shows input and output as indented JSON", () => {
    const view = toolCallView({ type: "dynamic-tool", toolName: "t", state: "output-available", input: { a: 1 }, output: { items: [] } });
    assert.equal(view.status, "done");
    assert.equal(view.output, '{\n  "items": []\n}');
    assert.equal(view.error, null);
  });
  test("a string output is shown as it is", () => {
    assert.equal(toolCallView({ type: "dynamic-tool", toolName: "t", state: "output-available", output: "plain" }).output, "plain");
  });
  test("an output-error part is failed, with its error text", () => {
    const view = toolCallView({ type: "dynamic-tool", toolName: "t", state: "output-error", input: { a: 1 }, errorText: "boom" });
    assert.equal(view.status, "failed");
    assert.equal(view.error, "boom");
  });
  test("an MCP result with isError is failed, with the text of its content", () => {
    const view = toolCallView({
      type: "dynamic-tool", toolName: "t", state: "output-available",
      output: { isError: true, content: [{ type: "text", text: "Unknown location" }, { type: "text", text: "Try Hermanus" }] },
    });
    assert.equal(view.status, "failed");
    assert.equal(view.error, "Unknown location\nTry Hermanus");
  });
  test("a state this code does not know is running, not done", () => {
    assert.equal(toolCallView({ type: "dynamic-tool", toolName: "t", state: "approval-requested" }).status, "running");
  });
  ```

- [ ] **Step 3: Run it.** `pnpm --filter @magic-events/web test`. Expected: FAIL, the module does not exist.

- [ ] **Step 4: Implement `tool-view.ts`**, then run the tests. Expected: PASS.

- [ ] **Step 5: Build the components**, composing the shadcn patterns as their pages show.
  - `markdown.tsx`: `Markdown`, Streamdown with fenced code routed to the shadcn Code Block.
  - `tool-call.tsx`: `ToolCall({ part })`. One `Trace` line from `toolCallView(part)`: the tool's name as the title, the status shown by icon and by words ("Calling", "Called", "Failed"), and a collapsible body with two labelled code blocks, "Input" and "Output" (or "Error" when failed). Each code block wraps long lines and scrolls inside `max-h-64`.
  - `chat-message.tsx`: `ChatMessage({ message })`. A user turn is an end-aligned muted bubble. An assistant turn renders its parts in order: `text` parts through `Markdown`, tool parts (`isToolPart`) through `ToolCall`; other part types are not rendered.
  - `chat-error.tsx`: `ChatError({ error, onRetry })`. When the error is the AI SDK's `APICallError` and `parseChatError(error.responseBody)` gives a body, show that body's `message` under a title per code: "Settings missing", "Feed not reachable", "API key rejected", "No tools". Otherwise show "Something went wrong" with the error's message. Always a "Try again" button.
  - `chat.tsx`: client component. `useChat()` on the default `/api/chat`. The thread in a Message Scroller with auto-scroll and the user's turn as the scroll anchor; an empty state reading "Ask what is on in Hermanus" with the line "The agent answers with the feed's MCP tools, as a tenant's agent would."; `ChatError` under the thread when `error` is set, retrying with `regenerate`; the prompt input as an Input Group textarea, placeholder "What is on in Hermanus in June 2027?", Enter sends and Shift+Enter adds a line, the send button disabled while the text is blank, and a stop button in its place while a reply is streaming.
  - `(dashboard)/chat/page.tsx`: renders the chat filling the page area.

- [ ] **Step 6: Verify without a feed.** `pnpm --filter @magic-events/web lint`, `typecheck`, `test`, `build`: all pass. Run the dev server with `MAGIC_EVENTS_API_KEY=test-key MAGIC_EVENTS_MCP_URL=http://localhost:4999/mcp`, open `/chat`, send a message. Expected: the user's bubble, then "Feed not reachable" with `http://localhost:4999/mcp` in the message, and "Try again" repeats the request.

- [ ] **Step 7: Verify end to end with a throwaway feed.** In the scratchpad directory (not in the repo), write a stateless MCP server on port 4010 with `@modelcontextprotocol/sdk`: it answers 401 unless the request carries `Authorization: Bearer test-key`; it has one tool, `search_experiences` (`query: string`), which returns 300 generated experiences as JSON text, or an `isError` result when `query` is `fail`. Run it from `apps/api` so the package resolves: `cd apps/api && node --input-type=module < <scratchpad>/fake-feed.mjs`. Run the web app with `MAGIC_EVENTS_API_KEY=test-key MAGIC_EVENTS_MCP_URL=http://localhost:4010/mcp` and check in the browser:
  - "What is on in Hermanus in June 2027?": a "Calling search_experiences" line that becomes "Called", whose body shows the input and the 300-item output scrolling inside its block, and then a reply rendered as markdown. The page itself does not grow sideways or jump.
  - "Search for exactly the query fail": the tool line shows "Failed" with the error text.
  - Restart the web app with `MAGIC_EVENTS_API_KEY=wrong`: sending shows "API key rejected".

  Stop both servers. The throwaway feed is not committed.

- [ ] **Step 8: Commit.** Paths: `apps/web` and `pnpm-lock.yaml`. Message: `Web: chat with the feed's tool calls shown`.
