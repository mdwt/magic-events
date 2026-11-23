import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The API is the inbound side of the system: REST, MCP and the scheduler. The domains, their ports and the outbound
// adapters are in packages/core, which checks its own rules. The rules here keep the inbound sides to their job:
//
//   src/rest, src/mcp   the two inbound sides clients reach: they call the core through its ports only
//   src/scheduler       the inbound side no client is behind: the same rule
//   src/app.ts          builds the server on the core's services
//   src/server.ts       the entry point. With app.ts, the only code that imports the wiring and an adapter

// The one exception in the core: Identity and Organizations use Better Auth directly. The inbound sides never do.
const BETTER_AUTH = ["better-auth", "better-auth/*", "@better-auth/*"];

function restrict(patterns) {
  return { "@typescript-eslint/no-restricted-imports": ["error", { patterns }] };
}

export default defineConfig([
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // node:test's describe, test and hooks return promises that the test runner itself awaits.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "test", "it", "suite", "before", "after", "beforeEach", "afterEach"],
            },
          ],
        },
      ],
    },
  },
  { files: ["**/*.mjs"], extends: [tseslint.configs.disableTypeChecked] },

  {
    files: ["src/rest/**/*.ts", "src/mcp/**/*.ts", "src/scheduler/**/*.ts"],
    rules: restrict([
      {
        group: ["@magic-events/db", "@magic-events/db/*", "drizzle-orm", "drizzle-orm/*", "postgres", ...BETTER_AUTH],
        message: "The inbound sides reach data and credentials through the core's services, never directly.",
      },
      {
        group: ["@aws-sdk/*", "@anthropic-ai/*"],
        message: "The inbound sides reach a model through the core's services, never directly.",
      },
      {
        group: ["pg", "pg-boss"],
        message: "The inbound sides reach the job queue through its port. server.ts hands it over.",
      },
      {
        regex: "^@magic-events/core/adapters/",
        message: "The inbound sides import no adapter. They are handed the core's services.",
      },
      {
        regex: "^@magic-events/core/[^/]+/service(\\.ts)?$",
        message: "Import the domain's ports, not its service. app.ts hands over the service.",
      },
      {
        regex: "^@magic-events/core/(services(\\.ts)?$|testing/)",
        message: "Only app.ts and server.ts import the wiring, and only tests import test helpers.",
      },
      { regex: "(^|/)app\\.ts$", message: "Only app.ts builds the server on the services." },
    ]),
  },
]);
