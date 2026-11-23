import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The end-to-end suite is a black box: it knows the system only through HTTP, its commands, its captured files and
// its log. So it imports nothing from the system's own projects.

export default defineConfig([
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@magic-events/*", "**/apps/api/**", "**/apps/cli/**", "**/packages/**"],
              message: "The end-to-end suite is a black box: reach the system over HTTP, its commands and its files.",
            },
          ],
        },
      ],
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
]);
