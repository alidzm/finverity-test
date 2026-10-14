import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@/shared/application/transaction-manager';
import { DatabaseService, type DbExecutor, type Transaction } from './database.service';

/**
 * `TransactionManager` adapter for Drizzle. The open transaction is kept in an
 * AsyncLocalStorage, so repositories pick it up implicitly (`executor`) and the
 * application layer never handles a Drizzle transaction object.
 *
 * Transactions run at READ COMMITTED — sufficient because capacity checks are single
 * conditional UPDATEs (see ARCHITECTURE.md §2.1).
 */
@Injectable()
export class DrizzleTransactionManager extends TransactionManager {
  private readonly current = new AsyncLocalStorage<Transaction>();

  constructor(private readonly database: DatabaseService) {
    super();
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const outer = this.current.getStore();
    // Nested call: a SAVEPOINT inside the outer transaction (Drizzle's nested transaction).
    return outer
      ? outer.transaction((tx) => this.current.run(tx, work))
      : this.database.db.transaction((tx) => this.current.run(tx, work));
  }

  /** The open transaction, or the pool when none is open (plain reads). */
  get executor(): DbExecutor {
    return this.current.getStore() ?? this.database.db;
  }

  /** The open transaction, for statements only correct inside one (row locks, multi-step writes). */
  get transaction(): Transaction {
    const tx = this.current.getStore();
    if (!tx) {
      throw new Error('This operation must run inside TransactionManager.run()');
    }
    return tx;
  }
}
