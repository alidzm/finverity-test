// CLI entry point: `pnpm db:migrate` locally, `node dist/migrate.js` in the container.
import { existsSync } from 'node:fs';
import { runMigrations } from '@/shared/infrastructure/database/migrations';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

try {
  await runMigrations(databaseUrl);
  console.log('Migrations applied');
} catch (error) {
  console.error('Migration failed', error);
  process.exit(1);
}
