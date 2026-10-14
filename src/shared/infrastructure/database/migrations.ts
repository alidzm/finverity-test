import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Arbitrary constant identifying the migration advisory lock. */
const MIGRATION_LOCK_ID = 7_316_204_118;

/**
 * Applies pending migrations. Holds a session advisory lock so that several instances
 * starting at once (e.g. a rolling deploy) cannot run migrations concurrently.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder = path.resolve('drizzle'),
): Promise<void> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'capacity-migrations',
  });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}
