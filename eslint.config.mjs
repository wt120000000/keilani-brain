// eslint.config.js
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,

  // Netlify Functions in CommonJS (e.g., healthz.js)
  {
    files: ["netlify/functions/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,     // process, __dirname, module, etc.
        ...globals.browser,  // console (and any incidental DOM-ish refs)
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "double"],
      "no-empty": ["warn", { "allowEmptyCatch": true }]
    },
  },

  // Netlify Functions in ESM (.mjs) – Node 18+ exposes fetch/Response globally
  {
    files: ["netlify/functions/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,     // process, etc.
        ...globals.browser,  // fetch, Response, URLSearchParams, console
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "double"],
      "no-empty": ["warn", { "allowEmptyCatch": true }]
    },
  },

  // Project scripts (if any)
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "double"],
      "no-empty": ["warn", { "allowEmptyCatch": true }]
    },
  },

  // Ignore everything else
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "public/**",
      ".netlify/**",
      "**/*.min.js",
      "**/vendor/**",
    ],
  },
];
