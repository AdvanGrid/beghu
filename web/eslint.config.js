// Lint for the web app, local and in CI: StyleX's own rules, plus beghu's (eslint-rules.js):
// colours only from the token module, no class or style attributes in JSX, and no CSS import
// but the escape stylesheet.
import css from "@eslint/css";
import stylex from "@stylexjs/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import beghu from "./eslint-rules.js";

export default [
  { ignores: ["dist/", "src/bindings/", "test-results/", "playwright-report/"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "@stylexjs": stylex, beghu },
    rules: {
      "@stylexjs/valid-styles": "error",
      "@stylexjs/no-unused": "error",
      "@stylexjs/sort-keys": "error",
      "beghu/no-colour-literals": "error",
      "beghu/no-class-or-style": "error",
      "beghu/one-escape-stylesheet": "error",
    },
  },
  {
    // The token module is where colours are written.
    files: ["src/tokens.stylex.ts"],
    rules: { "beghu/no-colour-literals": "off" },
  },
  {
    files: ["src/**/*.css"],
    language: "css/css",
    plugins: { css, beghu },
    rules: { "beghu/no-css-colours": "error" },
  },
];
