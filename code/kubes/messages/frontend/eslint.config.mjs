// @ts-check
// ESLint flat config for the Angular frontend. TYPE-AWARE: uses
// typescript-eslint's recommendedTypeChecked + stylisticTypeChecked, which pull
// real type information (parserOptions.projectService) to catch usage bugs the
// non-type-aware rules and tsc can't — floating promises, misused promises,
// unsafe `any` flows, await-on-non-thenable, etc. This runs locally on every
// commit (code/kubes/scripts/githooks/pre-commit), NOT in CI, because it needs
// the full TS program and is slower than a syntactic lint.
//
// Plus the Angular rules: forbid inline template:/styles: (every component uses
// templateUrl/styleUrl — the team's angular-external-template-style rule) and
// template accessibility.

import angular from "angular-eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      ...angular.configs.tsRecommended,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    processor: angular.processInlineTemplates,
    rules: {
      "@angular-eslint/component-max-inline-declarations": ["error", { template: 0, styles: 0 }],
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    files: ["src/**/*.html"],
    extends: [
      ...angular.configs.templateRecommended,
      ...angular.configs.templateAccessibility,
    ],
  },
);
