import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Each module owns its tables, next to its persistence adapters.
  schema: './src/**/*.schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://capacity:capacity@localhost:5432/capacity',
  },
  strict: true,
});
