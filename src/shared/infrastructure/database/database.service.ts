import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { AppConfig } from '@/config/app-config';

export type Database = NodePgDatabase;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run a query: the pool-backed database or an open transaction. */
export type DbExecutor = Database | Transaction;

/** Owns the connection pool. Queries go through `DrizzleTransactionManager`. */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: pg.Pool;
  readonly db: Database;

  constructor(config: AppConfig) {
    this.pool = new pg.Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      application_name: 'capacity-service',
      // Fail fast instead of piling up behind a stuck lock or a runaway query.
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.pool.on('error', (error) =>
      this.logger.error({ err: error }, 'Idle PostgreSQL client error'),
    );
    this.db = drizzle(this.pool);
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  /** Last shutdown phase: consumers, relay and HTTP server have already stopped using the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
