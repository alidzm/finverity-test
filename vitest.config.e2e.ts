import { defineConfig } from 'vitest/config';

// Integration / e2e tests: real PostgreSQL and Kafka via Testcontainers (Docker required).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
