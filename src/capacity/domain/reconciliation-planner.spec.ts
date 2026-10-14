import {
  buildReconciliationLedger,
  type LocalReservationState,
  planReconciliation,
  type ReservationWrite,
} from './reconciliation-planner';
import type { SnapshotReservation } from './reservation';

const AS_OF = new Date('2026-10-13T12:00:00Z');
const GRACE_MS = 5 * 60_000;
const minutes = (n: number) => new Date(AS_OF.getTime() + n * 60_000);

function local(
  invoiceId: string,
  overrides: Partial<LocalReservationState> = {},
): LocalReservationState {
  return {
    id: `id-${invoiceId}`,
    invoiceId,
    invoiceCurrency: 'USD',
    invoiceAmountMinor: 10000n,
    reservedMinor: 10000n,
    releasedMinor: 0n,
    releasedInvoiceMinor: 0n,
    status: 'ACTIVE',
    discrepancy: false,
    createdAt: minutes(-60),
    apiModifiedAt: minutes(-60),
    ...overrides,
  };
}

function snap(
  invoiceId: string,
  overrides: Partial<SnapshotReservation> = {},
): SnapshotReservation {
  return {
    invoiceId,
    invoiceCurrency: 'USD',
    invoiceAmountMinor: 10000n,
    reservedMinor: 10000n,
    releasedMinor: 0n,
    releasedInvoiceMinor: 0n,
    ...overrides,
  };
}

const plan = (localState: LocalReservationState[], snapshot: SnapshotReservation[]) =>
  planReconciliation({ asOf: AS_OF, graceMs: GRACE_MS, local: localState, snapshot });

describe('planReconciliation', () => {
  it('does nothing when local state already matches the snapshot', () => {
    const result = plan([local('A')], [snap('A')]);
    expect(result.writes).toEqual([]);
    expect(result.discrepancies).toEqual([]);
  });

  it('imports active reservations known only to treasury', () => {
    const result = plan([], [snap('T', { reservedMinor: 5000n, releasedMinor: 1000n })]);
    expect(result.writes).toEqual([
      expect.objectContaining({ invoiceId: 'T', status: 'ACTIVE', outstandingDeltaMinor: 4000n }),
    ]);
    expect(result.writes[0].existingId).toBeUndefined();
  });

  it('skips fully repaid reservations unknown locally', () => {
    const result = plan([], [snap('T', { releasedMinor: 10000n, releasedInvoiceMinor: 10000n })]);
    expect(result.writes).toEqual([]);
    expect(result.skippedUnknownReleased).toEqual(['T']);
  });

  it('adopts treasury state for reservations not changed through the API since asOf', () => {
    const result = plan(
      [local('A')],
      [snap('A', { releasedMinor: 10000n, releasedInvoiceMinor: 10000n })],
    );
    expect(result.writes).toEqual([
      expect.objectContaining({
        invoiceId: 'A',
        existingId: 'id-A',
        status: 'RELEASED',
        outstandingDeltaMinor: -10000n,
      }),
    ]);
  });

  it('keeps local state changed through the API after asOf', () => {
    const result = plan(
      [local('A', { status: 'RELEASED', releasedMinor: 10000n, apiModifiedAt: minutes(1) })],
      [snap('A')],
    );
    expect(result.writes).toEqual([]);
    expect(result.keptNewerLocal).toEqual(['A']);
  });

  it('keeps local API changes made within the grace window before asOf', () => {
    // Treasury may not have ingested a release made two minutes before its snapshot.
    const result = plan(
      [local('A', { status: 'RELEASED', releasedMinor: 10000n, apiModifiedAt: minutes(-2) })],
      [snap('A')],
    );
    expect(result.writes).toEqual([]);
    expect(result.keptNewerLocal).toEqual(['A']);
  });

  it('treats treasury-driven changes as covered by the snapshot', () => {
    // A treasury repayment applied after asOf does not set apiModifiedAt.
    const result = plan(
      [local('A', { releasedMinor: 2000n, releasedInvoiceMinor: 2000n, apiModifiedAt: null })],
      [snap('A', { releasedMinor: 3000n, releasedInvoiceMinor: 3000n })],
    );
    expect(result.writes).toEqual([
      expect.objectContaining({ invoiceId: 'A', outstandingDeltaMinor: -1000n }),
    ]);
  });

  it('keeps recent local reservations missing from the snapshot (in flight)', () => {
    const result = plan(
      [local('NEW', { createdAt: minutes(1) }), local('LAG', { createdAt: minutes(-2) })],
      [],
    );
    expect(result.keptInFlight).toEqual(['NEW', 'LAG']);
    expect(result.discrepancies).toEqual([]);
  });

  it('flags — but never releases — old local reservations missing from the snapshot', () => {
    const result = plan([local('OLD', { createdAt: minutes(-30) })], []);
    expect(result.discrepancies).toEqual([{ id: 'id-OLD', invoiceId: 'OLD' }]);
    expect(result.writes).toEqual([]);
  });

  it('clears a discrepancy once treasury reports the reservation', () => {
    const result = plan([local('A', { discrepancy: true })], [snap('A')]);
    expect(result.writes).toEqual([
      expect.objectContaining({ invoiceId: 'A', existingId: 'id-A', outstandingDeltaMinor: 0n }),
    ]);
  });

  it('ignores locally released reservations that treasury no longer reports', () => {
    const result = plan(
      [local('DONE', { status: 'RELEASED', releasedMinor: 10000n, releasedInvoiceMinor: 10000n })],
      [],
    );
    expect(result).toEqual({
      writes: [],
      discrepancies: [],
      keptNewerLocal: [],
      keptInFlight: [],
      skippedUnknownReleased: [],
    });
  });
});

describe('buildReconciliationLedger', () => {
  const write = (invoiceId: string, outstandingDeltaMinor: bigint): ReservationWrite => ({
    ...snap(invoiceId),
    status: 'ACTIVE',
    outstandingDeltaMinor,
  });

  it('journals the limit change and every adjustment with running balances', () => {
    const result = buildReconciliationLedger({
      before: { creditLimitMinor: 100_000n, reservedMinor: 30_000n },
      creditLimitMinor: 120_000n,
      writes: [write('A', 5_000n), write('B', 0n), write('C', -10_000n)],
      reservationIds: new Map([
        ['A', 'id-A'],
        ['C', 'id-C'],
      ]),
      reservedAfterMinor: 25_000n,
    });

    expect(result.driftMinor).toBe(0n);
    expect(result.ledger).toEqual([
      {
        entryType: 'LIMIT_CHANGE',
        deltaCreditLimitMinor: 20_000n,
        reservedAfterMinor: 30_000n,
        creditLimitAfterMinor: 120_000n,
      },
      {
        entryType: 'RECONCILIATION_ADJUSTMENT',
        reservationId: 'id-A',
        deltaReservedMinor: 5_000n,
        reservedAfterMinor: 35_000n,
        creditLimitAfterMinor: 120_000n,
      },
      {
        entryType: 'RECONCILIATION_ADJUSTMENT',
        reservationId: 'id-C',
        deltaReservedMinor: -10_000n,
        reservedAfterMinor: 25_000n,
        creditLimitAfterMinor: 120_000n,
      },
    ]);
  });

  it('records drift of the materialised counter as a final adjustment', () => {
    const result = buildReconciliationLedger({
      before: { creditLimitMinor: 100_000n, reservedMinor: 30_000n },
      creditLimitMinor: 100_000n,
      writes: [],
      reservationIds: new Map(),
      reservedAfterMinor: 29_000n,
    });

    expect(result.driftMinor).toBe(-1_000n);
    expect(result.ledger).toEqual([
      {
        entryType: 'RECONCILIATION_ADJUSTMENT',
        deltaReservedMinor: -1_000n,
        reservedAfterMinor: 29_000n,
        creditLimitAfterMinor: 100_000n,
      },
    ]);
  });
});
