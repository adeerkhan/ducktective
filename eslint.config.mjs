import js from "@eslint/js";
import prettier from "eslint-config-prettier";

/**
 * Flat ESLint config. The React/TypeScript plugins left with the website: this
 * repo is zero-dependency `.mjs` scripts, and `node --check` plus `node --test`
 * cover what the type layer used to.
 */
export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".venv*/",
      "ref/**",
      "evals/cases/**",
      "**/__pycache__/**",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      // The Node globals the scripts actually touch. `globals` was dropped with the
      // website; listing them keeps the config dependency-free and honest.
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  prettier,
];
