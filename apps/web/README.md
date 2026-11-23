# @magic-events/web

The web app, in Next.js 16 with React 19 and Tailwind CSS 4. It holds the page `create-next-app` made and nothing of
magic-events yet: it does not call the API.

## Layout

| Path | Holds |
| --- | --- |
| `src/app/layout.tsx` | The root layout |
| `src/app/page.tsx` | The home page |
| `src/app/globals.css` | Tailwind and the global styles |
| `public/` | Static files |
| `next.config.ts` | Next.js settings: Cache Components, partial prefetching, and Tailwind through Turbopack |

## Running it

From the repository root, `pnpm dev` runs it with the API, on port 3000. On its own:

```sh
pnpm --filter @magic-events/web dev
```

| Script | Does |
| --- | --- |
| `dev` | Runs the development server |
| `build` | Builds the app for production |
| `start` | Serves the production build |
| `lint` | Runs ESLint |
| `typecheck` | Generates Next.js's route types, then checks the types |

This version of Next.js differs from older ones. Read [AGENTS.md](AGENTS.md) before changing the code.
