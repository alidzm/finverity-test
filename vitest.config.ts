import { defineConfig } from 'vitest/config';

// Unit tests (domain logic) and the architecture test: pure, no Docker required.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
  },
});
