# magic-events

Event sourcing platform. pnpm monorepo: a Fastify API that also serves MCP, and a Next.js web app, backed by Postgres through Drizzle.

## Layout

- `apps/api` (`@magic-events/api`): Fastify 5 HTTP API. MCP is served over stateless Streamable HTTP at `POST /mcp`; MCP tools are registered in `src/mcp.ts`.
- `apps/web` (`@magic-events/web`): Next.js 16 (App Router, Turbopack, Tailwind 4). Read `apps/web/AGENTS.md` before working on it.
- `packages/db` (`@magic-events/db`): Drizzle schema (`src/schema.ts`), client factory (`createDb`), and migrations (`migrations/`).

## Commands

Run from the repo root:

- `pnpm install`: install all workspaces
- `pnpm db:up` / `pnpm db:down`: start or stop Postgres (docker compose)
- `pnpm db:generate`: generate a migration from schema changes
- `pnpm db:migrate`: apply migrations
- `pnpm dev`: run the API (port 4000) and web (port 3000) in parallel
- `pnpm typecheck`, `pnpm lint`, `pnpm build`

Target one package with `pnpm --filter @magic-events/<name> <script>`.

## Environment

- Every app reads the single `.env` at the repo root. Copy `.env.example` to `.env` to start.
- Never commit `.env` files. When you add a variable, add it to `.env.example`, and to `apps/api/src/env.ts` if the API reads it.

## Conventions

- TypeScript 7 (the native `tsc`) everywhere. Node 24+, ESM only.
- The API and `packages/db` run as `.ts` through Node's native type stripping, with no build step. As a result:
  - relative imports use the `.ts` extension (`import { x } from "./x.ts"`)
  - only erasable syntax is allowed: no `enum`, `namespace`, or parameter properties (`erasableSyntaxOnly` enforces this)
  - type-only imports use `import type` (`verbatimModuleSyntax`)
- Workspace packages export their TypeScript source directly (`"exports": "./src/index.ts"`).
- Validate inputs with zod 4.

## Event store

- `events` is append-only. Never update or delete rows.
- `global_position` is the total order across all streams. `(stream_id, stream_version)` is unique, which gives optimistic concurrency on append.
- Change the schema only through `packages/db/src/schema.ts` followed by `pnpm db:generate`. Never hand-edit generated migrations.

## Tooling notes

- TypeScript 7 ships no JS compiler API yet. `.pnpmfile.cjs` gives typescript-eslint packages TypeScript 6's API (`@typescript/typescript6`). Remove that hook once typescript-eslint supports TS 7.
- ESLint is pinned to 9 because the plugins `eslint-config-next` uses (react, import, jsx-a11y) don't support ESLint 10 yet.
