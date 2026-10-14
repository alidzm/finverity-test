import { DomainError } from '@/shared/domain/domain-error';
import type { LedgerEntry } from './ledger';
import type { ProgramState } from './program';
import {
  outstandingMinor,
  type ReservationState,
  type ReservationStatus,
  type SnapshotReservation,
  treasuryStatus,
} from './reservation';

/** The parts of a local reservation that reconciliation compares. */
export type LocalReservationState = Pick<
  ReservationState,
  | 'id'
  | 'invoiceId'
  | 'invoiceCurrency'
  | 'invoiceAmountMinor'
  | 'reservedMinor'
  | 'releasedMinor'
  | 'releasedInvoiceMinor'
  | 'status'
  | 'discrepancy'
  | 'createdAt'
  | 'apiModifiedAt'
>;

/** Treasury state to write for one reservation (insert or overwrite). */
export interface ReservationWrite extends SnapshotReservation {
  /** Present when the reservation already exists locally. */
  existingId?: string;
  status: ReservationStatus;
  /** Change of the outstanding (still reserved) amount, in program currency. */
  outstandingDeltaMinor: bigint;
}

/** A snapshot lists each invoice once and never releases more than was reserved. */
export function ensureConsistentSnapshot(snapshot: readonly SnapshotReservation[]): void {
  const seen = new Set<string>();
  for (const item of snapshot) {
    if (seen.has(item.invoiceId)) {
      throw invalidSnapshot(`Duplicate invoice '${item.invoiceId}' in snapshot`);
    }
    seen.add(item.invoiceId);
    if (
      item.releasedMinor > item.reservedMinor ||
      item.releasedInvoiceMinor > item.invoiceAmountMinor
    ) {
      throw invalidSnapshot(
        `Released amounts exceed reserved amounts for invoice '${item.invoiceId}'`,
      );
    }
  }
}

export interface ReconciliationInput {
  asOf: Date;
  graceMs: number;
  /** Every local ACTIVE reservation plus any local reservation present in the snapshot. */
  local: readonly LocalReservationState[];
  snapshot: readonly SnapshotReservation[];
}

export interface ReconciliationPlan {
  writes: ReservationWrite[];
  /** Local ACTIVE reservations treasury should know about but does not: keep holding, flag. */
  discrepancies: { id: string; invoiceId: string }[];
  /** Changed through our API after `asOf − grace`: the snapshot may be older, keep local state. */
  keptNewerLocal: string[];
  /** Created too recently for treasury to have seen them: keep as is. */
  keptInFlight: string[];
  /** Fully repaid invoices unknown locally: nothing to hold, not imported. */
  skippedUnknownReleased: string[];
}

/**
 * Merges a treasury snapshot into local state.
 *
 * Rule: the snapshot is authoritative for everything up to `asOf`; changes made through
 * this service's API after `asOf` are preserved on top of it. Treasury learns about our
 * changes asynchronously, so "after" is widened by the grace window: an API change made
 * shortly before `asOf` may not be reflected in the snapshot yet. When information is
 * missing, the plan keeps capacity reserved (under-allocation is the safe failure mode).
 */
export function planReconciliation(input: ReconciliationInput): ReconciliationPlan {
  const plan: ReconciliationPlan = {
    writes: [],
    discrepancies: [],
    keptNewerLocal: [],
    keptInFlight: [],
    skippedUnknownReleased: [],
  };
  const localByInvoice = new Map(input.local.map((r) => [r.invoiceId, r]));
  const snapshotInvoiceIds = new Set<string>();
  // Local changes after this instant may not have reached treasury when it took the snapshot.
  const lagThreshold = input.asOf.getTime() - input.graceMs;

  for (const item of input.snapshot) {
    snapshotInvoiceIds.add(item.invoiceId);
    const local = localByInvoice.get(item.invoiceId);
    const status = treasuryStatus(item);
    const outstandingAfter = status === 'ACTIVE' ? item.reservedMinor - item.releasedMinor : 0n;

    if (!local) {
      if (status === 'RELEASED') {
        plan.skippedUnknownReleased.push(item.invoiceId);
      } else {
        plan.writes.push({ ...item, status, outstandingDeltaMinor: outstandingAfter });
      }
      continue;
    }

    if (local.apiModifiedAt && local.apiModifiedAt.getTime() > lagThreshold) {
      plan.keptNewerLocal.push(item.invoiceId);
      continue;
    }

    if (!local.discrepancy && sameState(local, item, status)) {
      continue;
    }
    plan.writes.push({
      ...item,
      existingId: local.id,
      status,
      outstandingDeltaMinor: outstandingAfter - outstandingMinor(local),
    });
  }

  for (const local of input.local) {
    if (local.status !== 'ACTIVE' || snapshotInvoiceIds.has(local.invoiceId)) {
      continue;
    }
    if (local.createdAt.getTime() > lagThreshold) {
      plan.keptInFlight.push(local.invoiceId);
    } else {
      plan.discrepancies.push({ id: local.id, invoiceId: local.invoiceId });
    }
  }

  return plan;
}

export interface ReconciliationLedgerInput {
  /** Program state before the snapshot was applied. */
  before: Pick<ProgramState, 'creditLimitMinor' | 'reservedMinor'>;
  /** Limit reported by the snapshot. */
  creditLimitMinor: bigint;
  writes: readonly ReservationWrite[];
  /** Ids of the written reservations, by invoice id. */
  reservationIds: ReadonlyMap<string, string>;
  /** Reserved amount recomputed from the reservations after the writes. */
  reservedAfterMinor: bigint;
}

/**
 * Journal of a reconciliation: the limit change, one adjustment per changed reservation and,
 * last, any drift of the materialised reserved counter — non-zero only if the invariant
 * `reserved = Σ outstanding` had been broken before.
 */
export function buildReconciliationLedger(input: ReconciliationLedgerInput): {
  ledger: LedgerEntry[];
  driftMinor: bigint;
} {
  const { before, creditLimitMinor } = input;
  const ledger: LedgerEntry[] = [];
  if (creditLimitMinor !== before.creditLimitMinor) {
    ledger.push({
      entryType: 'LIMIT_CHANGE',
      deltaCreditLimitMinor: creditLimitMinor - before.creditLimitMinor,
      reservedAfterMinor: before.reservedMinor,
      creditLimitAfterMinor: creditLimitMinor,
    });
  }
  let running = before.reservedMinor;
  for (const write of input.writes) {
    if (write.outstandingDeltaMinor === 0n) {
      continue;
    }
    running += write.outstandingDeltaMinor;
    ledger.push({
      entryType: 'RECONCILIATION_ADJUSTMENT',
      reservationId: input.reservationIds.get(write.invoiceId),
      deltaReservedMinor: write.outstandingDeltaMinor,
      reservedAfterMinor: running,
      creditLimitAfterMinor: creditLimitMinor,
    });
  }
  const driftMinor = input.reservedAfterMinor - running;
  if (driftMinor !== 0n) {
    ledger.push({
      entryType: 'RECONCILIATION_ADJUSTMENT',
      deltaReservedMinor: driftMinor,
      reservedAfterMinor: input.reservedAfterMinor,
      creditLimitAfterMinor: creditLimitMinor,
    });
  }
  return { ledger, driftMinor };
}

function invalidSnapshot(message: string): DomainError {
  return new DomainError('INVALID_TREASURY_MESSAGE', message);
}

function sameState(
  local: LocalReservationState,
  item: SnapshotReservation,
  status: ReservationStatus,
): boolean {
  return (
    local.status === status &&
    local.invoiceCurrency === item.invoiceCurrency &&
    local.invoiceAmountMinor === item.invoiceAmountMinor &&
    local.reservedMinor === item.reservedMinor &&
    local.releasedMinor === item.releasedMinor &&
    local.releasedInvoiceMinor === item.releasedInvoiceMinor
  );
}
