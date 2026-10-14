/**
 * Port: unit-of-work boundary for use cases.
 *
 * Everything awaited inside `run()` — repositories, the journal, the inbox — shares one
 * database transaction without it being passed around, so the application layer never
 * sees a persistence-specific transaction object. A nested `run()` joins the outer
 * transaction as a savepoint: its failure rolls back only its own work.
 */
export abstract class TransactionManager {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}
