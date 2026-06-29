// @ts-check
// ESLint flat config for the Angular frontend — mirrors the health/home apps.
// Adds Angular-semantic rules: forbid inline template:/styles: (every component
// uses templateUrl/styleUrl with sibling .html/.scss — the team's
// angular-external-template-style rule), plus template accessibility.

import angular from "angular-eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.stylistic,
      ...angular.configs.tsRecommended,
    ],
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
