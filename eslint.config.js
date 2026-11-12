import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  { ignores: ["**/dist/**", "**/coverage/**", "**/.claude/**", "**/.worktrees/**"] },
  {
    files: ["**/*.{js,jsx,mjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // This rules block replaces js.configs.recommended's, so no-undef must be named here.
      // Without it, an out-of-scope handler crashed a coach page while lint stayed green.
      "no-undef": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", {
        allowConstantExport: true,
        // Context hooks and a pure label helper intentionally share their component modules.
        allowExportNames: ["useAuth", "classificationLabel"],
      }],
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^[A-Z_]",
      }],
    },
  },
];
