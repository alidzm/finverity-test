import { InvariantViolationError } from '@/shared/domain/invariant';
import { IDENTITY_RATE, parseRate } from '@/shared/domain/money/fx';
import type { Amount } from '@/shared/domain/money/money';
import type { ChangeOrigin } from './change-source';
import { Program, type ProgramState, type TreasurySnapshot } from './program';
import {
  type LockedRate,
  type NewRelease,
  Reservation,
  type ReservationState,
  type SnapshotReservation,
} from './reservation';

const NOW = new Date('2026-10-13T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const API: ChangeOrigin = { source: 'API', actor: 'invoice-service', correlationId: 'req-1' };
const TREASURY: ChangeOrigin = { source: 'TREASURY', actor: 'treasury', correlationId: 'msg-1' };
const usd = (minor: bigint): Amount => ({ minor, currency: 'USD' });

function program(overrides: Partial<ProgramState> = {}): Program {
  return Program.reconstitute({
    id: 'PRG-1',
    currency: 'USD',
    creditLimitMinor: 100_000n,
    reservedMinor: 30_000n,
    status: 'ACTIVE',
    version: 3,
    treasurySequence: 10,
    lastReconciledAt: null,
    updatedAt: minutes(-60),
    ...overrides,
  });
}

const SAME_CURRENCY: LockedRate = { rate: IDENTITY_RATE, asOf: null };

const reserve = (subject: Program, amount: Amount, rate = SAME_CURRENCY) =>
  subject.reserve({ reservationId: 'res-1', invoiceId: 'INV-1', amount, rate }, API, NOW);

describe('Program', () => {
  it('is created by treasury, its limit journaled as a change from zero', () => {
    const { program: created, ledger } = Program.create(
      {
        id: 'PRG-2',
        currency: 'EUR',
        terms: { creditLimitMinor: 50_000n, status: 'ACTIVE' },
        treasurySequence: 7,
      },
      NOW,
    );
    expect(created).toMatchObject({ reservedMinor: 0n, version: 1, treasurySequence: 7 });
    expect(ledger).toEqual([{ entryType: 'LIMIT_CHANGE', deltaCreditLimitMinor: 50_000n }]);
  });

  it('cannot be in a state that breaks its invariants', () => {
    expect(() => program({ reservedMinor: -1n })).toThrow(InvariantViolationError);
    expect(() => program({ creditLimitMinor: -1n })).toThrow(InvariantViolationError);
    expect(() => program({ version: 0 })).toThrow(InvariantViolationError);
  });

  it('is immutable: transitions return a new program', () => {
    const subject = program();
    reserve(subject, usd(1_000n));
    expect(subject.reservedMinor).toBe(30_000n);
    expect(Object.isFrozen(subject)).toBe(true);
  });

  it('can be over its limit after treasury lowers it', () => {
    expect(program().availableMinor).toBe(70_000n);
    expect(program({ creditLimitMinor: 20_000n }).availableMinor).toBe(-10_000n);
  });

  describe('reserve', () => {
    it('opens a reservation and takes its capacity', () => {
      const result = reserve(program(), usd(20_000n));
      expect(result.program).toMatchObject({ reservedMinor: 50_000n, version: 4 });
      expect(result.reservation).toMatchObject({
        id: 'res-1',
        programId: 'PRG-1',
        invoiceId: 'INV-1',
        reservedMinor: 20_000n,
        status: 'ACTIVE',
        source: 'API',
        apiModifiedAt: NOW,
        createdBy: 'invoice-service',
        createdAt: NOW,
      });
      expect(result.ledger).toEqual([
        { entryType: 'RESERVE', reservationId: 'res-1', deltaReservedMinor: 20_000n },
      ]);
    });

    it('converts at the locked rate, rounding up', () => {
      const rate = { rate: parseRate('1.08345'), asOf: minutes(-5) };
      // 0.01 EUR × 1.08345 = 0.0108345 USD → 0.02 USD
      const { reservation } = reserve(program(), { minor: 1n, currency: 'EUR' }, rate);
      expect(reservation).toMatchObject({
        invoiceCurrency: 'EUR',
        invoiceAmountMinor: 1n,
        reservedMinor: 2n,
        fxRate: '1.08345',
        fxRateAsOf: minutes(-5),
      });
    });

    it('takes the last available unit, but no more', () => {
      expect(reserve(program(), usd(70_000n)).program.availableMinor).toBe(0n);
      expect(() => reserve(program(), usd(70_001n))).toThrow(
        expect.objectContaining({
          code: 'INSUFFICIENT_CAPACITY',
          details: expect.objectContaining({ requested: '700.01', available: '700.00' }),
        }),
      );
    });

    it('rejects reservations on suspended or over-limit programs', () => {
      expect(() => reserve(program({ status: 'SUSPENDED' }), usd(1n))).toThrow(
        expect.objectContaining({ code: 'PROGRAM_SUSPENDED' }),
      );
      expect(() => reserve(program({ creditLimitMinor: 20_000n }), usd(1n))).toThrow(
        expect.objectContaining({ code: 'INSUFFICIENT_CAPACITY' }),
      );
    });

    it('does not count treasury-originated reservations as API changes', () => {
      const { reservation } = program().reserve(
        { reservationId: 'res-1', invoiceId: 'INV-1', amount: usd(1n), rate: SAME_CURRENCY },
        TREASURY,
        NOW,
      );
      expect(reservation).toMatchObject({ source: 'TREASURY', apiModifiedAt: null });
    });
  });

  it('takes back the capacity a release freed', () => {
    const release: NewRelease = {
      programId: 'PRG-1',
      reservationId: 'res-1',
      releaseId: 'RPM-1',
      invoiceAmountMinor: 10_000n,
      programAmountMinor: 10_000n,
      source: 'API',
      createdBy: 'invoice-service',
      correlationId: null,
    };
    const { program: next, ledger } = program().releaseCapacity(release);
    expect(next).toMatchObject({ reservedMinor: 20_000n, version: 4 });
    expect(ledger).toEqual([
      { entryType: 'RELEASE', reservationId: 'res-1', deltaReservedMinor: -10_000n },
    ]);
    expect(() => program().releaseCapacity({ ...release, programId: 'PRG-2' })).toThrow(
      InvariantViolationError,
    );
  });

  it('applies treasury terms; the capacity version moves only with visible changes', () => {
    expect(
      program().applyTerms({ creditLimitMinor: 100_000n, status: 'ACTIVE' }, 11),
    ).toMatchObject({ changed: false, ledger: [], program: { treasurySequence: 11, version: 3 } });
    expect(
      program().applyTerms({ creditLimitMinor: 100_000n, status: 'SUSPENDED' }, 11),
    ).toMatchObject({ changed: true, ledger: [], program: { status: 'SUSPENDED', version: 4 } });
    expect(
      program().applyTerms({ creditLimitMinor: 150_000n, status: 'ACTIVE' }, 11),
    ).toMatchObject({
      changed: true,
      ledger: [{ entryType: 'LIMIT_CHANGE', deltaCreditLimitMinor: 50_000n }],
    });
  });

  it('acknowledges a treasury message without a visible change', () => {
    expect(program().acknowledge(12)).toMatchObject({ treasurySequence: 12, version: 3 });
  });

  it('treats treasury messages that are not newer than the last applied one as applied', () => {
    expect(program().hasApplied(9)).toBe(true);
    expect(program().hasApplied(10)).toBe(true);
    expect(program().hasApplied(11)).toBe(false);
  });

  it('never changes currency', () => {
    expect(() => program().ensureCurrency('USD')).not.toThrow();
    expect(() => program().ensureCurrency('EUR')).toThrow(
      expect.objectContaining({ code: 'PROGRAM_CURRENCY_IMMUTABLE' }),
    );
  });

  describe('reconcile', () => {
    function reservation(invoiceId: string, overrides: Partial<ReservationState> = {}) {
      return Reservation.reconstitute({
        id: `id-${invoiceId}`,
        programId: 'PRG-1',
        invoiceId,
        programCurrency: 'USD',
        invoiceCurrency: 'USD',
        invoiceAmountMinor: 10_000n,
        fxRate: '1',
        fxRateAsOf: null,
        reservedMinor: 10_000n,
        releasedMinor: 0n,
        releasedInvoiceMinor: 0n,
        status: 'ACTIVE',
        source: 'API',
        discrepancy: false,
        apiModifiedAt: minutes(-60),
        createdBy: 'invoice-service',
        createdAt: minutes(-60),
        updatedAt: minutes(-60),
        ...overrides,
      });
    }

    const snap = (invoiceId: string, overrides: Partial<SnapshotReservation> = {}) => ({
      invoiceId,
      invoiceCurrency: 'USD' as const,
      invoiceAmountMinor: 10_000n,
      reservedMinor: 10_000n,
      releasedMinor: 0n,
      releasedInvoiceMinor: 0n,
      ...overrides,
    });

    const snapshot = (
      reservations: SnapshotReservation[],
      overrides: Partial<TreasurySnapshot> = {},
    ): TreasurySnapshot => ({
      sequence: 11,
      asOf: NOW,
      currency: 'USD',
      terms: { creditLimitMinor: 100_000n, status: 'ACTIVE' },
      reservations,
      ...overrides,
    });

    const reconcile = (subject: Program, local: Reservation[], input: TreasurySnapshot) =>
      subject.reconcile({
        snapshot: input,
        local,
        graceMs: 5 * 60_000,
        origin: TREASURY,
        now: NOW,
        newReservationId: () => 'id-new',
      });

    it('adopts treasury terms and reservations and re-derives the reserved amount', () => {
      const result = reconcile(
        program({ reservedMinor: 20_000n }),
        [reservation('A'), reservation('B')],
        snapshot(
          [
            snap('A', { releasedMinor: 10_000n, releasedInvoiceMinor: 10_000n }),
            snap('B'),
            snap('T', { invoiceAmountMinor: 5_000n, reservedMinor: 5_000n }),
          ],
          { terms: { creditLimitMinor: 120_000n, status: 'ACTIVE' } },
        ),
      );

      expect(result.program).toMatchObject({
        creditLimitMinor: 120_000n,
        reservedMinor: 15_000n,
        treasurySequence: 11,
        lastReconciledAt: NOW,
        version: 4,
      });
      expect(result.reservations).toEqual([
        expect.objectContaining({ id: 'id-A', status: 'RELEASED', releasedMinor: 10_000n }),
        expect.objectContaining({ id: 'id-new', invoiceId: 'T', source: 'TREASURY', fxRate: null }),
      ]);
      expect(result.ledger).toEqual([
        {
          entryType: 'LIMIT_CHANGE',
          deltaCreditLimitMinor: 20_000n,
          reservedAfterMinor: 20_000n,
          creditLimitAfterMinor: 120_000n,
        },
        {
          entryType: 'RECONCILIATION_ADJUSTMENT',
          reservationId: 'id-A',
          deltaReservedMinor: -10_000n,
          reservedAfterMinor: 10_000n,
          creditLimitAfterMinor: 120_000n,
        },
        {
          entryType: 'RECONCILIATION_ADJUSTMENT',
          reservationId: 'id-new',
          deltaReservedMinor: 5_000n,
          reservedAfterMinor: 15_000n,
          creditLimitAfterMinor: 120_000n,
        },
      ]);
      expect(result.driftMinor).toBe(0n);
    });

    it('flags — but keeps holding — what treasury lost, and heals a drifted counter', () => {
      // The counter says 250.00, but the reservations it should sum up hold 300.00.
      const result = reconcile(
        program({ reservedMinor: 25_000n }),
        [reservation('LOST'), reservation('B'), reservation('FLAGGED', { discrepancy: true })],
        snapshot([snap('B')]),
      );

      expect(result.reservations).toEqual([
        expect.objectContaining({ id: 'id-LOST', status: 'ACTIVE', discrepancy: true }),
      ]);
      expect(result.plan.discrepancies.map((item) => item.invoiceId)).toEqual(['LOST', 'FLAGGED']);
      expect(result.program.reservedMinor).toBe(30_000n);
      expect(result.driftMinor).toBe(5_000n);
    });

    it('rejects snapshots in another currency or listing an invoice twice', () => {
      expect(() => reconcile(program(), [], snapshot([], { currency: 'EUR' }))).toThrow(
        expect.objectContaining({ code: 'PROGRAM_CURRENCY_IMMUTABLE' }),
      );
      expect(() => reconcile(program(), [], snapshot([snap('A'), snap('A')]))).toThrow(
        expect.objectContaining({ code: 'INVALID_TREASURY_MESSAGE' }),
      );
    });
  });
});
