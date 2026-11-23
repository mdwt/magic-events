import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The architecture rules from docs/architecture.md, checked here so they hold by tooling and not by convention.
//
//   src/<domain>/     ports.ts and service.ts: no adapter, no provider's SDK, no database client
//   src/shared/       what belongs to no domain: errors, the logger, settings, and the shared ports
//   src/adapters/     outbound adapters: each implements a port and is the only code that imports its technology
//   src/services.ts   wires adapters and services together. It is the only code here that imports both
//   src/testing/      what tests use, in this package and in the apps: the harness and the fakes
//
// The apps (apps/api, apps/cli) reach this package through the domains' ports and services.ts. Their own lint
// rules keep REST, MCP and the scheduler away from the adapters and the services.

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
  regex: "(^|/)(adapters|testing)/|(^|/)services\\.ts$",
  message: "A domain imports no adapter, no test helper and not the wiring.",
};

function restrict(patterns) {
  return { "@typescript-eslint/no-restricted-imports": ["error", { patterns }] };
}

function domainRules(domain) {
  const allowed = CALLS[domain];
  const forbidden = DOMAINS.filter((other) => other !== domain && !allowed.includes(other));
  const technology = ["identity", "organizations"].includes(domain) ? TECHNOLOGY : [...TECHNOLOGY, ...BETTER_AUTH];
  const patterns = [
    { group: technology, message: "A domain imports no provider's SDK and no database client. Reach it through a port." },
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
  return { files: [`src/${domain}/**/*.ts`], rules: restrict(patterns) };
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

  ...DOMAINS.map(domainRules),
  {
    files: ["src/shared/**/*.ts"],
    rules: restrict([
      { group: [...TECHNOLOGY, ...BETTER_AUTH], message: "Shared code imports no provider's SDK and no database client." },
      outsideTheCore,
      { regex: `(^|/)(${DOMAINS.join("|")})/`, message: "Shared code belongs to no domain and imports none." },
    ]),
  },
  {
    files: ["src/adapters/**/*.ts"],
    rules: restrict([
      {
        regex: `(^|/)(${DOMAINS.join("|")})/service(\\.ts)?$`,
        message: "An adapter imports the port it implements, not a service.",
      },
      {
        regex: "(^|/)testing/|(^|/)services\\.ts$",
        message: "An adapter imports no test helper and not the wiring.",
      },
    ]),
  },
]);
