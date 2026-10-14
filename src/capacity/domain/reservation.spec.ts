import { InvariantViolationError } from '@/shared/domain/invariant';
import type { Amount } from '@/shared/domain/money/money';
import type { ChangeOrigin } from './change-source';
import {
  type Release,
  Reservation,
  type ReservationState,
  type SnapshotReservation,
} from './reservation';

const NOW = new Date('2026-10-13T12:00:00Z');
const EARLIER = new Date('2026-10-01T09:00:00Z');
const API: ChangeOrigin = { source: 'API', actor: 'invoice-service', correlationId: 'req-1' };
const TREASURY: ChangeOrigin = { source: 'TREASURY', actor: 'treasury', correlationId: 'msg-1' };
const eur = (minor: bigint): Amount => ({ minor, currency: 'EUR' });

function reservation(overrides: Partial<ReservationState> = {}): Reservation {
  // 1,000.00 EUR reserved as 1,083.45 USD
  return Reservation.reconstitute({
    id: 'res-1',
    programId: 'PRG-1',
    invoiceId: 'INV-1',
    programCurrency: 'USD',
    invoiceCurrency: 'EUR',
    invoiceAmountMinor: 100_000n,
    fxRate: '1.08345',
    fxRateAsOf: EARLIER,
    reservedMinor: 108_345n,
    releasedMinor: 0n,
    releasedInvoiceMinor: 0n,
    status: 'ACTIVE',
    source: 'API',
    discrepancy: false,
    apiModifiedAt: EARLIER,
    createdBy: 'invoice-service',
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  });
}

const FULLY_RELEASED = {
  status: 'RELEASED',
  releasedMinor: 108_345n,
  releasedInvoiceMinor: 100_000n,
} as const;

describe('Reservation', () => {
  it('cannot be in a state that breaks its invariants', () => {
    expect(() => reservation({ releasedMinor: 108_346n })).toThrow(InvariantViolationError);
    expect(() => reservation({ releasedInvoiceMinor: 100_001n })).toThrow(InvariantViolationError);
    expect(() => reservation({ status: 'RELEASED' })).toThrow(InvariantViolationError);
    expect(() => reservation({ ...FULLY_RELEASED, status: 'ACTIVE' })).toThrow(
      InvariantViolationError,
    );
  });

  it('is immutable: transitions return a new reservation', () => {
    const subject = reservation();
    subject.release({ releaseId: 'RPM-1', origin: API, now: NOW });
    expect(subject.status).toBe('ACTIVE');
    expect(Object.isFrozen(subject)).toBe(true);
  });

  it('holds its outstanding amount only while active', () => {
    expect(reservation({ releasedMinor: 8_345n }).outstandingMinor).toBe(100_000n);
    expect(reservation(FULLY_RELEASED).outstandingMinor).toBe(0n);
  });

  it('accepts an idempotent replay only with the identical amount', () => {
    const existing = reservation();
    expect(existing.ensureSameRequest(eur(100_000n))).toBe(existing);
    expect(() => existing.ensureSameRequest(eur(100_001n))).toThrow(
      expect.objectContaining({ code: 'RESERVATION_CONFLICT' }),
    );
    expect(() => existing.ensureSameRequest({ minor: 100_000n, currency: 'USD' })).toThrow(
      expect.objectContaining({ code: 'RESERVATION_CONFLICT' }),
    );
  });

  describe('release', () => {
    const release = (subject: Reservation, requested?: Amount, origin = API) =>
      subject.release({ releaseId: 'RPM-1', requested, origin, now: NOW });

    it('releases a partial repayment at the locked rate', () => {
      // 333.33 EUR of 1,000.00 → floor(108,345 × 33,333 / 100,000) = 361.14 USD
      const outcome = release(reservation(), eur(33_333n));
      expect(outcome.reservation).toMatchObject({
        status: 'ACTIVE',
        releasedMinor: 36_114n,
        releasedInvoiceMinor: 33_333n,
        apiModifiedAt: NOW,
      });
      expect(outcome.release).toEqual({
        programId: 'PRG-1',
        reservationId: 'res-1',
        releaseId: 'RPM-1',
        invoiceAmountMinor: 33_333n,
        programAmountMinor: 36_114n,
        source: 'API',
        createdBy: 'invoice-service',
        correlationId: 'req-1',
      });
    });

    it('releases everything outstanding when no amount is given', () => {
      const outcome = release(
        reservation({ releasedInvoiceMinor: 40_000n, releasedMinor: 43_338n }),
      );
      expect(outcome.reservation).toMatchObject(FULLY_RELEASED);
      expect(outcome.release).toMatchObject({
        invoiceAmountMinor: 60_000n,
        programAmountMinor: 65_007n,
      });
    });

    it('keeps the API timestamp for treasury repayments', () => {
      expect(release(reservation(), eur(1_000n), TREASURY).reservation.apiModifiedAt).toBe(EARLIER);
    });

    it.each([
      [
        'an already released reservation',
        reservation(FULLY_RELEASED),
        eur(1n),
        'RESERVATION_ALREADY_RELEASED',
      ],
      [
        'a different currency',
        reservation(),
        { minor: 1n, currency: 'USD' } as Amount,
        'CURRENCY_MISMATCH',
      ],
      [
        'more than outstanding',
        reservation({ releasedInvoiceMinor: 99_999n }),
        eur(2n),
        'RELEASE_EXCEEDS_OUTSTANDING',
      ],
    ])('rejects releasing from %s', (_, subject, amount, code) => {
      expect(() => release(subject, amount)).toThrow(expect.objectContaining({ code }));
    });
  });

  it('accepts a release replay only for the same invoice and amount', () => {
    const prior: Release = {
      id: 'rel-1',
      programId: 'PRG-1',
      reservationId: 'res-1',
      releaseId: 'RPM-1',
      invoiceAmountMinor: 25_000n,
      programAmountMinor: 27_086n,
      source: 'API',
      createdBy: 'invoice-service',
      correlationId: null,
      createdAt: NOW,
    };
    const target = reservation();
    expect(() => target.ensureSameRelease(prior, 'INV-1', eur(25_000n))).not.toThrow();
    expect(() => target.ensureSameRelease(prior, 'INV-1')).not.toThrow();
    expect(() => target.ensureSameRelease(prior, 'INV-2', eur(25_000n))).toThrow(
      expect.objectContaining({ code: 'RELEASE_CONFLICT' }),
    );
    expect(() => target.ensureSameRelease(prior, 'INV-1', eur(25_001n))).toThrow(
      expect.objectContaining({ code: 'RELEASE_CONFLICT' }),
    );
  });

  describe('reconciliation', () => {
    const snapshot: SnapshotReservation = {
      invoiceId: 'INV-1',
      invoiceCurrency: 'EUR',
      invoiceAmountMinor: 100_000n,
      reservedMinor: 108_340n,
      releasedMinor: 54_170n,
      releasedInvoiceMinor: 50_000n,
    };

    it('adopts treasury state, clears a discrepancy and keeps what it was opened with', () => {
      expect(reservation({ discrepancy: true }).adoptTreasuryState(snapshot)).toMatchObject({
        reservedMinor: 108_340n,
        releasedMinor: 54_170n,
        status: 'ACTIVE',
        discrepancy: false,
        fxRate: '1.08345',
        source: 'API',
        createdAt: EARLIER,
      });
      const repaid = { ...snapshot, releasedMinor: 108_340n, releasedInvoiceMinor: 100_000n };
      expect(reservation().adoptTreasuryState(repaid).status).toBe('RELEASED');
    });

    it('imports a reservation known only to treasury as reported', () => {
      const imported = Reservation.importFromTreasury({
        id: 'res-9',
        program: { id: 'PRG-1', currency: 'USD' },
        snapshot,
        origin: TREASURY,
        now: NOW,
      });
      expect(imported).toMatchObject({
        id: 'res-9',
        source: 'TREASURY',
        status: 'ACTIVE',
        fxRate: null,
        apiModifiedAt: null,
        createdBy: 'treasury',
        createdAt: NOW,
        outstandingMinor: 54_170n,
      });
    });

    it('flags a discrepancy without releasing anything', () => {
      expect(reservation().flagDiscrepancy()).toMatchObject({
        discrepancy: true,
        status: 'ACTIVE',
        outstandingMinor: 108_345n,
      });
    });
  });
});
