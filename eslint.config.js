// eslint.config.js
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,

  // Netlify Functions: Node + CommonJS (exports, require, process, etc.)
  {
    files: ["netlify/functions/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "double"],
    },
  },

  // Project scripts: Node + ESM (if you add any under scripts/)
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
