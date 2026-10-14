import type { LedgerEntry } from '@/capacity/domain/ledger';
import type { Program } from '@/capacity/domain/program';
import type { OperationContext } from '@/capacity/application/operation-context';

export type CapacityEventType =
  'ReservationCreated' | 'ReservationReleased' | 'ProgramCapacityUpdated' | 'ProgramReconciled';

export interface CapacityChange {
  /** Program state after the change, as stored. */
  program: Program;
  ledger: readonly LedgerEntry[];
  /** Integration event for other systems; the program's capacity is attached automatically. */
  event?: { type: CapacityEventType; payload: Record<string, unknown> };
  context: OperationContext;
}

/**
 * Port: the side effects every capacity change must have, recorded atomically with it —
 * the ledger (audit), the outbound event and the live notification for subscribers.
 * Must be called inside `TransactionManager.run()`.
 */
export abstract class CapacityJournal {
  abstract record(change: CapacityChange): Promise<void>;
}
