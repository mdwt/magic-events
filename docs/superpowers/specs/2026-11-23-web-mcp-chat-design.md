# Web app: tenant dashboard with an MCP chat

## Intent

A visual utility for testing the feed the way a tenant integrates with it. A tenant's AI agent reaches the feed through
MCP; this app is a chat where an agent does exactly that, and shows what it sent and what came back. The API is still
being built, so this version gets the installation and the wiring right, and works end to end as soon as the API serves
MCP.

## Goals

- `apps/web` runs on the latest Next.js with shadcn/ui and Tailwind.
- A dashboard layout, the one a tenant will see, with the chat as its one page.
- The chat's agent uses the feed's MCP tools, authenticated as a tenant.
- Every tool call is visible in the chat with its input and its output.

## Constraints

- No sign-in in the web app. The API authenticates with an API key in `Authorization: Bearer`, for MCP the same as for
  REST ([issues.md](../../issues.md), issue 4). The web app holds one tenant's key in an environment variable and never
  sends it to the browser.
- The API has no server and no MCP endpoint yet. The web app must build, lint, typecheck and run without it.
- `apps/web/AGENTS.md`: this Next.js version has breaking changes. Read the guides in `node_modules/next/dist/docs/`
  before writing code.

## Approaches

- **Next.js with the Vercel AI SDK and AI Elements (picked).** `useChat` in the browser, one route handler on the
  server that runs the model with the MCP server's tools. It was named in the request, it is the shortest path from
  Next.js to a streaming chat with tool calls, and AI Elements installs into the project as shadcn components, so the
  chat and the dashboard share one component system.
- **A hand-built chat on `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`.** The same packages the API uses, with no
  new ones. It means writing the streaming protocol, the tool loop and the message components by hand, which is the
  work the AI SDK and AI Elements already do.
- **The Anthropic API's MCP connector, where the model provider calls the MCP server.** The provider cannot reach an
  MCP server on `localhost`, so it does not work for local testing.

## Design

### Installation

In `apps/web`, already on Next.js 16.4.6, React 19.3 and Tailwind 4.3.5:

- shadcn/ui, initialised for Tailwind 4 and the `src/` directory, with the `@/*` alias that `tsconfig.json` already has.
- The AI SDK: `ai`, `@ai-sdk/react`, the AI SDK's MCP client, and `@ai-sdk/anthropic`.
- AI Elements, added through the shadcn CLI into `src/components/ai-elements`.

### Layout

The shadcn sidebar is the dashboard shell: a sidebar with the product name and the navigation, a header, and the page
area. The navigation has one entry, the chat. The create-next-app page and its images are removed.

### Server

`POST /api/chat`, a route handler:

1. Opens an MCP client to `MAGIC_EVENTS_MCP_URL` over streamable HTTP, with `Authorization: Bearer
   <MAGIC_EVENTS_API_KEY>`.
2. Reads the MCP server's tools and hands them to `streamText`, with Claude as the model.
3. Streams the result to the browser as a UI message stream, and closes the MCP client when the stream ends.

If the MCP server cannot be reached or rejects the key, the route answers with an error the chat can show. It does not
fall back to a chat without tools.

### Chat

`useChat` with AI Elements: the conversation, the messages, the prompt input, and a tool component for each tool call
that shows the tool's name, its input, its output and its state. When the route reports that the MCP server is not
reachable, the chat shows that plainly, with the URL it tried.

### Settings

| Setting | Default | What it is |
| --- | --- | --- |
| `MAGIC_EVENTS_API_KEY` | None | The tenant's API key, as printed by the seed. Server only |
| `MAGIC_EVENTS_MCP_URL` | `http://localhost:4000/mcp` | The feed's MCP endpoint |
| `ANTHROPIC_API_KEY` | None | The key for the chat's model. The same setting the API's data processing uses |

They are added to the root `.env.example`. The web app reads the root `.env`, as the API does.

## Decisions made by the builder

- Claude is the chat's model, through `@ai-sdk/anthropic`, because the project already has `ANTHROPIC_API_KEY`.
- The setting names above.
- The MCP path `/mcp` is a default only. The API decides its own path, and the setting follows it.

## Left to the builder

- The exact package versions, the shadcn style and base colour, and which AI Elements components the chat needs.
- The model id, kept in one place.
- How the web app loads the root `.env`.
