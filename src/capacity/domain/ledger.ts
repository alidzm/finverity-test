export const LEDGER_ENTRY_TYPES = [
  'RESERVE',
  'RELEASE',
  'LIMIT_CHANGE',
  'RECONCILIATION_ADJUSTMENT',
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * One line of the append-only capacity journal; it explains every change of a program's
 * limit or reserved amount (program-currency minor units).
 */
export interface LedgerEntry {
  entryType: LedgerEntryType;
  reservationId?: string | null;
  deltaReservedMinor?: bigint;
  deltaCreditLimitMinor?: bigint;
  /** Balances after this entry; default to the program state after the whole change. */
  reservedAfterMinor?: bigint;
  creditLimitAfterMinor?: bigint;
}
