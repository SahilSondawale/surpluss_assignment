import { defineConfig } from 'vitest/config';

/** Unit tests: fast, no database. Files live next to the code as *.spec.ts. */
export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
