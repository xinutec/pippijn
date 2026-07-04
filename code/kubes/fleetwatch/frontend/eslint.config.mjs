// @ts-check
// ESLint flat config for the Angular frontend. Type-aware (typescript-eslint
// recommendedTypeChecked + stylisticTypeChecked) plus the Angular rules (forbid
// inline template:/styles:, template a11y). Runs as the normal lint in CI:
// `npm run lint`.

import angular from "angular-eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ts-rs writes src/app/generated/ from the Rust types — don't lint generated code.
  { ignores: ["src/app/generated/**"] },
  {
    files: ["src/**/*.ts"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      ...angular.configs.tsRecommended,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    processor: angular.processInlineTemplates,
    rules: {
      "@angular-eslint/component-max-inline-declarations": ["error", { template: 0, styles: 0 }],
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    files: ["src/**/*.html"],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
);
