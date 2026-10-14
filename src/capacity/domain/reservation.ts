import { DomainError } from '@/shared/domain/domain-error';
import { invariant } from '@/shared/domain/invariant';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { convertMinor, type ExchangeRate, formatRate } from '@/shared/domain/money/fx';
import { type Amount, formatAmount } from '@/shared/domain/money/money';
import type { ChangeOrigin, ChangeSource } from './change-source';
import type { ProgramState } from './program';
import { computeRelease } from './release-calculation';

export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED'] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Stored state of a reservation: the capacity held for one approved invoice. */
export interface ReservationState {
  readonly id: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly programCurrency: CurrencyCode;
  readonly invoiceCurrency: CurrencyCode;
  readonly invoiceAmountMinor: bigint;
  /** Rate locked at reservation time (invoice → program currency); null if created by treasury. */
  readonly fxRate: string | null;
  readonly fxRateAsOf: Date | null;
  /** Capacity held, in program currency; fixed when the reservation is opened. */
  readonly reservedMinor: bigint;
  readonly releasedMinor: bigint;
  readonly releasedInvoiceMinor: bigint;
  readonly status: ReservationStatus;
  readonly source: ChangeSource;
  /** Treasury does not know this reservation although it should (see reconciliation). */
  readonly discrepancy: boolean;
  /** Last mutation originated by this service's API; drives reconciliation precedence. */
  readonly apiModifiedAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One applied (partial) repayment of a reservation; append-only. */
export interface Release {
  readonly id: string;
  readonly programId: string;
  readonly reservationId: string;
  /** Repayment id supplied by the client or treasury: the idempotency key of the release. */
  readonly releaseId: string;
  readonly invoiceAmountMinor: bigint;
  readonly programAmountMinor: bigint;
  readonly source: ChangeSource;
  readonly createdBy: string | null;
  readonly correlationId: string | null;
  readonly createdAt: Date;
}

/** A release to append; storage assigns its id and timestamp. */
export type NewRelease = Omit<Release, 'id' | 'createdAt'>;

/** A reservation as reported by a treasury snapshot (amounts in minor units). */
export interface SnapshotReservation {
  readonly invoiceId: string;
  readonly invoiceCurrency: CurrencyCode;
  readonly invoiceAmountMinor: bigint;
  readonly reservedMinor: bigint;
  readonly releasedMinor: bigint;
  readonly releasedInvoiceMinor: bigint;
}

/** The rate locked on a reservation: 1 invoice-currency unit = `rate` program-currency units. */
export interface LockedRate {
  readonly rate: ExchangeRate;
  /** When treasury published the rate; null when no conversion is needed. */
  readonly asOf: Date | null;
}

export interface ReleaseOutcome {
  readonly reservation: Reservation;
  readonly release: NewRelease;
}

/** What transitions may change; everything else is fixed when the reservation is opened. */
type MutableReservationState = Pick<
  ReservationState,
  | 'invoiceCurrency'
  | 'invoiceAmountMinor'
  | 'reservedMinor'
  | 'releasedMinor'
  | 'releasedInvoiceMinor'
  | 'status'
  | 'discrepancy'
  | 'apiModifiedAt'
>;

/**
 * Aggregate: the capacity held for one approved invoice, and its releases.
 *
 * Immutable — every transition returns a new instance — and constructible only through its
 * factories or `reconstitute`; the constructor checks the invariants, so no code can hold a
 * reservation in an invalid state. New reservations are opened by `Program.reserve()`, which
 * checks the program's available capacity first.
 */
export class Reservation implements ReservationState {
  declare readonly id: string;
  declare readonly programId: string;
  declare readonly invoiceId: string;
  declare readonly programCurrency: CurrencyCode;
  declare readonly invoiceCurrency: CurrencyCode;
  declare readonly invoiceAmountMinor: bigint;
  declare readonly fxRate: string | null;
  declare readonly fxRateAsOf: Date | null;
  declare readonly reservedMinor: bigint;
  declare readonly releasedMinor: bigint;
  declare readonly releasedInvoiceMinor: bigint;
  declare readonly status: ReservationStatus;
  declare readonly source: ChangeSource;
  declare readonly discrepancy: boolean;
  declare readonly apiModifiedAt: Date | null;
  declare readonly createdBy: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  private constructor(state: ReservationState) {
    const subject = `Reservation ${state.id}`;
    invariant(state.invoiceAmountMinor > 0n, `${subject}: the invoice amount must be positive`);
    invariant(state.reservedMinor >= 0n, `${subject}: the reserved amount is negative`);
    invariant(
      state.releasedMinor >= 0n && state.releasedMinor <= state.reservedMinor,
      `${subject}: released more capacity than it holds`,
    );
    invariant(
      state.releasedInvoiceMinor >= 0n && state.releasedInvoiceMinor <= state.invoiceAmountMinor,
      `${subject}: released more than the invoice amount`,
    );
    invariant(
      (state.status === 'RELEASED') === (state.releasedMinor === state.reservedMinor),
      `${subject}: status ${state.status} does not match the released amount`,
    );
    Object.assign(this, state);
    Object.freeze(this);
  }

  /**
   * Opens a reservation for an approved invoice. The invoice amount is converted into the
   * program currency at `rate`, rounded up — never hold less than the invoice is worth — and
   * the rate is locked for the life of the reservation. Only `Program.reserve()` calls this,
   * after checking capacity (enforced by test/architecture.spec.ts).
   */
  static open(input: {
    id: string;
    program: Pick<ProgramState, 'id' | 'currency'>;
    invoiceId: string;
    amount: Amount;
    rate: LockedRate;
    origin: ChangeOrigin;
    now: Date;
  }): Reservation {
    const { program, amount, rate, origin, now } = input;
    return new Reservation({
      id: input.id,
      programId: program.id,
      invoiceId: input.invoiceId,
      programCurrency: program.currency,
      invoiceCurrency: amount.currency,
      invoiceAmountMinor: amount.minor,
      fxRate: formatRate(rate.rate),
      fxRateAsOf: rate.asOf,
      reservedMinor: convertMinor(
        amount.minor,
        amount.currency,
        program.currency,
        rate.rate,
        'CEIL',
      ),
      releasedMinor: 0n,
      releasedInvoiceMinor: 0n,
      status: 'ACTIVE',
      source: origin.source,
      discrepancy: false,
      apiModifiedAt: apiModification(origin, now, null),
      createdBy: origin.actor,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** A reservation known only to treasury, imported from a snapshot exactly as reported. */
  static importFromTreasury(input: {
    id: string;
    program: Pick<ProgramState, 'id' | 'currency'>;
    snapshot: SnapshotReservation;
    origin: ChangeOrigin;
    now: Date;
  }): Reservation {
    const { program, snapshot, origin, now } = input;
    return new Reservation({
      id: input.id,
      programId: program.id,
      invoiceId: snapshot.invoiceId,
      programCurrency: program.currency,
      invoiceCurrency: snapshot.invoiceCurrency,
      invoiceAmountMinor: snapshot.invoiceAmountMinor,
      fxRate: null,
      fxRateAsOf: null,
      reservedMinor: snapshot.reservedMinor,
      releasedMinor: snapshot.releasedMinor,
      releasedInvoiceMinor: snapshot.releasedInvoiceMinor,
      status: treasuryStatus(snapshot),
      source: 'TREASURY',
      discrepancy: false,
      apiModifiedAt: null,
      createdBy: origin.actor,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Rebuilds a stored reservation. Only repositories call this (see test/architecture.spec.ts). */
  static reconstitute(state: ReservationState): Reservation {
    return new Reservation(state);
  }

  /** Capacity still held, in program currency. */
  get outstandingMinor(): bigint {
    return outstandingMinor(this);
  }

  /**
   * An invoice reserves at most once per program, so re-submitting it is an idempotent replay —
   * allowed only with the identical amount.
   */
  ensureSameRequest(requested: Amount): this {
    if (
      requested.currency === this.invoiceCurrency &&
      requested.minor === this.invoiceAmountMinor
    ) {
      return this;
    }
    throw new DomainError(
      'RESERVATION_CONFLICT',
      'A reservation for this invoice already exists with a different amount',
      {
        invoiceId: this.invoiceId,
        existingAmount: {
          value: formatAmount(this.invoiceAmountMinor, this.invoiceCurrency),
          currency: this.invoiceCurrency,
        },
      },
    );
  }

  /**
   * Releases a (partial) repayment at the rate locked on the reservation. `requested` is in
   * invoice currency; omitted = everything still outstanding.
   */
  release(input: {
    releaseId: string;
    requested?: Amount;
    origin: ChangeOrigin;
    now: Date;
  }): ReleaseOutcome {
    const { requested, origin } = input;
    if (this.status === 'RELEASED') {
      throw new DomainError(
        'RESERVATION_ALREADY_RELEASED',
        'The reservation has already been fully released',
        { invoiceId: this.invoiceId },
      );
    }
    const outstandingInvoiceMinor = this.invoiceAmountMinor - this.releasedInvoiceMinor;
    if (requested) {
      invariant(requested.minor > 0n, `Reservation ${this.id}: release amount must be positive`);
      if (requested.currency !== this.invoiceCurrency) {
        throw new DomainError(
          'CURRENCY_MISMATCH',
          'Release amount must be in the invoice currency',
          {
            expected: this.invoiceCurrency,
            actual: requested.currency,
          },
        );
      }
      if (requested.minor > outstandingInvoiceMinor) {
        throw new DomainError(
          'RELEASE_EXCEEDS_OUTSTANDING',
          'Release amount exceeds the outstanding invoice amount',
          {
            outstanding: {
              value: formatAmount(outstandingInvoiceMinor, this.invoiceCurrency),
              currency: this.invoiceCurrency,
            },
          },
        );
      }
    }
    const invoiceAmountMinor = requested?.minor ?? outstandingInvoiceMinor;
    const computed = computeRelease(this, invoiceAmountMinor);
    return {
      reservation: this.with({
        releasedMinor: computed.releasedMinorAfter,
        releasedInvoiceMinor: computed.releasedInvoiceMinorAfter,
        status: computed.fullyReleased ? 'RELEASED' : 'ACTIVE',
        apiModifiedAt: apiModification(origin, input.now, this.apiModifiedAt),
      }),
      release: {
        programId: this.programId,
        reservationId: this.id,
        releaseId: input.releaseId,
        invoiceAmountMinor,
        programAmountMinor: computed.programAmountMinor,
        source: origin.source,
        createdBy: origin.actor,
        correlationId: origin.correlationId,
      },
    };
  }

  /** A releaseId may be re-submitted only for the same invoice and amount (idempotent replay). */
  ensureSameRelease(prior: Release, invoiceId: string, requested?: Amount): void {
    invariant(
      prior.reservationId === this.id,
      `Release ${prior.releaseId} belongs to another reservation`,
    );
    const sameAmount =
      !requested ||
      (requested.currency === this.invoiceCurrency && requested.minor === prior.invoiceAmountMinor);
    if (this.invoiceId !== invoiceId || !sameAmount) {
      throw new DomainError(
        'RELEASE_CONFLICT',
        'This releaseId was already used for a different release',
        { releaseId: prior.releaseId, invoiceId: this.invoiceId },
      );
    }
  }

  /** Adopts treasury's view of this reservation (reconciliation); clears a discrepancy. */
  adoptTreasuryState(snapshot: SnapshotReservation): Reservation {
    invariant(
      snapshot.invoiceId === this.invoiceId,
      `Reservation ${this.id}: snapshot of another invoice`,
    );
    return this.with({
      invoiceCurrency: snapshot.invoiceCurrency,
      invoiceAmountMinor: snapshot.invoiceAmountMinor,
      reservedMinor: snapshot.reservedMinor,
      releasedMinor: snapshot.releasedMinor,
      releasedInvoiceMinor: snapshot.releasedInvoiceMinor,
      status: treasuryStatus(snapshot),
      discrepancy: false,
    });
  }

  /** Treasury should know this reservation but does not: keep holding its capacity, flag it. */
  flagDiscrepancy(): Reservation {
    return this.with({ discrepancy: true });
  }

  /** The state as a plain object, for storage. */
  toState(): ReservationState {
    return {
      id: this.id,
      programId: this.programId,
      invoiceId: this.invoiceId,
      programCurrency: this.programCurrency,
      invoiceCurrency: this.invoiceCurrency,
      invoiceAmountMinor: this.invoiceAmountMinor,
      fxRate: this.fxRate,
      fxRateAsOf: this.fxRateAsOf,
      reservedMinor: this.reservedMinor,
      releasedMinor: this.releasedMinor,
      releasedInvoiceMinor: this.releasedInvoiceMinor,
      status: this.status,
      source: this.source,
      discrepancy: this.discrepancy,
      apiModifiedAt: this.apiModifiedAt,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  private with(changes: Partial<MutableReservationState>): Reservation {
    return new Reservation({ ...this.toState(), ...changes });
  }
}

/** Capacity still held, in program currency. */
export function outstandingMinor(
  reservation: Pick<ReservationState, 'status' | 'reservedMinor' | 'releasedMinor'>,
): bigint {
  return reservation.status === 'ACTIVE'
    ? reservation.reservedMinor - reservation.releasedMinor
    : 0n;
}

/** Treasury reports amounts only: a reservation is released once all its capacity is back. */
export function treasuryStatus(
  snapshot: Pick<SnapshotReservation, 'reservedMinor' | 'releasedMinor'>,
): ReservationStatus {
  return snapshot.releasedMinor >= snapshot.reservedMinor ? 'RELEASED' : 'ACTIVE';
}

export function reservationNotFound(programId: string, invoiceId: string): DomainError {
  return new DomainError('RESERVATION_NOT_FOUND', `No reservation for invoice '${invoiceId}'`, {
    programId,
    invoiceId,
  });
}

/** Only changes made through this service's API take precedence in reconciliation (§4). */
function apiModification(origin: ChangeOrigin, now: Date, previous: Date | null): Date | null {
  return origin.source === 'API' ? now : previous;
}
