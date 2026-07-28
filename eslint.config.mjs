import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // stub-server.mjs is spawned as a standalone script, not part of the build.
  { ignores: ["out/**", "node_modules/**", "src/test/stub-server.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // The viewer registry intentionally stores `this`; this isn't the
      // `const self = this` closure hack the rule targets.
      "@typescript-eslint/no-this-alias": "off",
    },
  },
);
