import { defineConfig } from 'vitest/config';

// The backend (this package) and the Angular frontend each have their own,
// incompatible test runners. The frontend's *.spec.ts files are compiled and
// executed by the Angular `@angular/build:unit-test` builder (`npm run
// test:frontend`), which initializes the Angular TestBed and Vitest globals.
//
// Without scoping the include/exclude here, the backend `vitest run` would also
// discover the frontend specs and try to run them in the bare Node environment,
// where `describe`/`it`/`expect` are undefined and `@angular/compiler` is not
// available. Keep this run limited to the backend's own tests.
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'frontend/**'],
  },
});
