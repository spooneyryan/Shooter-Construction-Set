import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import next from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  next.configs["core-web-vitals"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      // The Inspector's labels nest their text as <span><b>NAME</b><em>value</em></span>
      // beside the wrapped control — depth 3 from the <label>, one past the
      // rule's default search budget of 2, so it reported "must have
      // accessible text" for markup whose accessible name is fine: a wrapping
      // label's name is computed from its whole subtree. Deeper look, same rule.
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
    },
  },
]);

export default eslintConfig;
