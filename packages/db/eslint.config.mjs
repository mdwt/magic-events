import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["migrations/**"]),
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: {
      "no-console": "off",
    },
  },
]);
