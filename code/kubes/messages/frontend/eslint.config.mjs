// @ts-check
// ESLint flat config for the Angular frontend. Two tiers from one config:
//   - default (`npm run lint`): FAST, non-type-aware — typescript-eslint
//     recommended + stylistic + Angular rules + template a11y. Runs in CI.
//   - ESLINT_TYPE_AWARE=1 (`npm run lint:types`): adds the TYPE-CHECKED rule
//     sets (recommendedTypeChecked + stylisticTypeChecked, via
//     parserOptions.projectService) — floating/misused promises, unsafe `any`,
//     await-thenable, etc. Needs the full TS program + is slower, so it runs
//     LOCALLY on every commit (code/kubes/scripts/githooks/pre-commit), not CI.
//
// Angular rules either way: forbid inline template:/styles: (the team's
// angular-external-template-style rule) and template accessibility.

import angular from "angular-eslint";
import tseslint from "typescript-eslint";

const typeAware = process.env.ESLINT_TYPE_AWARE === "1";

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    extends: [
      ...(typeAware ? tseslint.configs.recommendedTypeChecked : tseslint.configs.recommended),
      ...(typeAware ? tseslint.configs.stylisticTypeChecked : tseslint.configs.stylistic),
      ...angular.configs.tsRecommended,
    ],
    ...(typeAware
      ? { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } }
      : {}),
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
