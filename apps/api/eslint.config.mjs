import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The architecture rules from docs/architecture.md, checked here so they hold by tooling and not by convention.
//
//   src/core/<domain>/  ports.ts and service.ts: no adapter, no provider's SDK, no database client
//   src/rest, src/mcp   the two inbound sides clients reach: they call the core through its ports only
//   src/scheduler       the inbound side no client is behind: the same rule
//   src/adapters/       outbound adapters: each implements a port and is the only code that imports its technology
//   src/app.ts          wires the system together, and is the only code that imports adapters and services

const TECHNOLOGY = [
  "@magic-events/db",
  "@magic-events/db/*",
  "drizzle-orm",
  "drizzle-orm/*",
  "postgres",
  "pg",
  "pg-boss",
  "fastify",
  "fastify-*",
  "@fastify/*",
  "@modelcontextprotocol/*",
  "pino",
  "pino-*",
  "@anthropic-ai/*",
  "@aws-sdk/*",
];

// The one exception: Identity and Organizations use Better Auth directly, with no port over it.
const BETTER_AUTH = ["better-auth", "better-auth/*", "@better-auth/*"];

// Which domains a domain may call, from "How domains talk". Organizations calls nobody.
const CALLS = {
  catalogue: ["data-processing"],
  organizations: [],
  discovery: ["catalogue"],
  "data-processing": ["discovery", "catalogue"],
  identity: ["organizations"],
};
const DOMAINS = Object.keys(CALLS);

const outsideTheCore = {
  regex: "(^|/)(adapters|rest|mcp|scheduler|seed|cli)/|(^|/)(app|server)\\.ts$",
  message: "The core imports no adapter and nothing from the inbound sides.",
};

function restrict(patterns) {
  return { "@typescript-eslint/no-restricted-imports": ["error", { patterns }] };
}

function coreRules(domain) {
  const allowed = CALLS[domain];
  const forbidden = DOMAINS.filter((other) => other !== domain && !allowed.includes(other));
  const technology = ["identity", "organizations"].includes(domain) ? TECHNOLOGY : [...TECHNOLOGY, ...BETTER_AUTH];
  const patterns = [
    { group: technology, message: "A domain's core imports no provider's SDK and no database client. Reach it through a port." },
    outsideTheCore,
    {
      regex: `(^|/)(${forbidden.join("|")})/`,
      message: `${domain} does not call this domain. See "How domains talk" in docs/architecture.md.`,
    },
  ];
  if (allowed.length > 0) {
    patterns.push({
      regex: `(^|/)(${allowed.join("|")})/(?!ports\\.ts$)`,
      message: "A domain calls another domain only through that domain's ports.",
    });
  }
  return { files: [`src/core/${domain}/**/*.ts`], rules: restrict(patterns) };
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

  ...DOMAINS.map(coreRules),
  {
    files: ["src/core/shared/**/*.ts"],
    rules: restrict([
      { group: [...TECHNOLOGY, ...BETTER_AUTH], message: "Shared core code imports no provider's SDK and no database client." },
      outsideTheCore,
      { regex: `(^|/)(${DOMAINS.join("|")})/`, message: "Shared core code belongs to no domain and imports none." },
    ]),
  },
  {
    files: ["src/rest/**/*.ts", "src/mcp/**/*.ts", "src/scheduler/**/*.ts"],
    rules: restrict([
      {
        group: ["@magic-events/db", "@magic-events/db/*", "drizzle-orm", "drizzle-orm/*", "postgres", ...BETTER_AUTH],
        message: "The inbound sides reach data and credentials through the core's services, never directly.",
      },
      {
        group: ["@aws-sdk/*"],
        message: "The inbound sides reach the embedding model through Catalogue's service. app.ts hands it over.",
      },
      {
        group: ["pg", "pg-boss"],
        message: "The inbound sides reach the job queue through its port. app.ts and server.ts hand it over.",
      },
      { regex: "(^|/)adapters/", message: "The inbound sides import no adapter. They are handed the core's services." },
      { regex: "/core/[^/]+/service(\\.ts)?$", message: "Import the domain's ports, not its service. app.ts hands over the service." },
      { regex: "(^|/)app\\.ts$", message: "Only app.ts wires the system together." },
    ]),
  },
  {
    files: ["src/adapters/**/*.ts"],
    rules: restrict([
      { regex: "/core/[^/]+/service(\\.ts)?$", message: "An adapter imports the port it implements, not a service." },
      {
        regex: "(^|/)(rest|mcp|scheduler|seed|cli)/|(^|/)(app|server)\\.ts$",
        message: "An adapter imports nothing from the inbound sides or the wiring.",
      },
    ]),
  },
  {
    // Scripts run by a person at a terminal.
    files: ["src/seed/**/*.ts", "src/cli/**/*.ts"],
    rules: { "no-console": "off" },
  },
]);
