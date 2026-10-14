import { DomainError } from '@/shared/domain/domain-error';
import { invariant } from '@/shared/domain/invariant';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { type Amount, formatAmount } from '@/shared/domain/money/money';
import type { ChangeOrigin } from './change-source';
import type { LedgerEntry } from './ledger';
import {
  buildReconciliationLedger,
  ensureConsistentSnapshot,
  planReconciliation,
  type ReconciliationPlan,
} from './reconciliation-planner';
import {
  type LockedRate,
  type NewRelease,
  Reservation,
  type SnapshotReservation,
} from './reservation';

export const PROGRAM_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

/** Stored state of a financing program. Amounts are program-currency minor units. */
export interface ProgramState {
  readonly id: string;
  /** Set by treasury when the program is created; never changes. */
  readonly currency: CurrencyCode;
  readonly creditLimitMinor: bigint;
  readonly reservedMinor: bigint;
  readonly status: ProgramStatus;
  /** Incremented on every change clients can see; exposed to them as the capacity version. */
  readonly version: number;
  /** Highest treasury stream sequence applied to this program. */
  readonly treasurySequence: number;
  readonly lastReconciledAt: Date | null;
  readonly updatedAt: Date;
}

/** Terms treasury controls: the limit and whether new reservations are accepted. */
export interface ProgramTerms {
  readonly creditLimitMinor: bigint;
  readonly status: ProgramStatus;
}

/** A new program state together with the journal lines that explain it. */
export interface ProgramChange {
  readonly program: Program;
  readonly ledger: readonly LedgerEntry[];
}

/** An approved invoice asking for capacity. */
export interface ReservationRequest {
  /** Identity of the reservation to open. */
  readonly reservationId: string;
  readonly invoiceId: string;
  /** Invoice amount, in invoice currency. */
  readonly amount: Amount;
  /** Invoice → program currency; locked on the reservation for its whole life. */
  readonly rate: LockedRate;
}

/** A full treasury snapshot of one program, authoritative up to `asOf`. */
export interface TreasurySnapshot {
  readonly sequence: number;
  readonly asOf: Date;
  readonly currency: CurrencyCode;
  readonly terms: ProgramTerms;
  readonly reservations: readonly SnapshotReservation[];
}

export interface Reconciliation extends ProgramChange {
  /** Reservations to store: adopted from treasury, imported from it, or newly flagged. */
  readonly reservations: readonly Reservation[];
  readonly plan: ReconciliationPlan;
  /** Correction of the reserved counter; 0 unless `reserved = Σ outstanding` had been broken. */
  readonly driftMinor: bigint;
}

/** What transitions may change; the id and currency are fixed when treasury creates a program. */
type MutableProgramState = Pick<
  ProgramState,
  'creditLimitMinor' | 'reservedMinor' | 'status' | 'treasurySequence' | 'lastReconciledAt'
>;

/**
 * Aggregate root: a financing program and its capacity.
 *
 * Immutable — every transition returns a new instance plus the journal lines explaining it —
 * and constructible only through `create` or `reconstitute`; the constructor checks the
 * invariants, so no code can hold a program in an invalid state. Transitions must be applied
 * to the current state read under the program lock (ARCHITECTURE.md §2.1).
 */
export class Program implements ProgramState {
  declare readonly id: string;
  declare readonly currency: CurrencyCode;
  declare readonly creditLimitMinor: bigint;
  declare readonly reservedMinor: bigint;
  declare readonly status: ProgramStatus;
  declare readonly version: number;
  declare readonly treasurySequence: number;
  declare readonly lastReconciledAt: Date | null;
  declare readonly updatedAt: Date;

  private constructor(state: ProgramState) {
    const subject = `Program ${state.id}`;
    invariant(state.creditLimitMinor >= 0n, `${subject}: the credit limit is negative`);
    invariant(state.reservedMinor >= 0n, `${subject}: the reserved amount is negative`);
    invariant(
      Number.isSafeInteger(state.version) && state.version >= 1,
      `${subject}: invalid version ${state.version}`,
    );
    invariant(
      Number.isSafeInteger(state.treasurySequence) && state.treasurySequence >= 0,
      `${subject}: invalid treasury sequence ${state.treasurySequence}`,
    );
    Object.assign(this, state);
    Object.freeze(this);
  }

  /** A program announced by treasury; its initial limit is journaled as a change from zero. */
  static create(
    input: { id: string; currency: CurrencyCode; terms: ProgramTerms; treasurySequence: number },
    now: Date,
  ): ProgramChange {
    const program = new Program({
      id: input.id,
      currency: input.currency,
      creditLimitMinor: input.terms.creditLimitMinor,
      reservedMinor: 0n,
      status: input.terms.status,
      version: 1,
      treasurySequence: input.treasurySequence,
      lastReconciledAt: null,
      updatedAt: now,
    });
    return { program, ledger: limitChange(0n, program.creditLimitMinor) };
  }

  /** Rebuilds a stored program. Only repositories call this (see test/architecture.spec.ts). */
  static reconstitute(state: ProgramState): Program {
    return new Program(state);
  }

  /** May be negative: treasury can lower the limit below what is already reserved (over-limit). */
  get availableMinor(): bigint {
    return this.creditLimitMinor - this.reservedMinor;
  }

  /** Treasury messages are sequenced per program; anything not newer was already applied. */
  hasApplied(sequence: number): boolean {
    return sequence <= this.treasurySequence;
  }

  ensureAcceptsReservations(): void {
    if (this.status !== 'ACTIVE') {
      throw new DomainError(
        'PROGRAM_SUSPENDED',
        `Program '${this.id}' is not accepting reservations`,
        { programId: this.id },
      );
    }
  }

  /** A program's currency is set when treasury creates it and never changes. */
  ensureCurrency(currency: CurrencyCode): void {
    if (this.currency !== currency) {
      throw new DomainError('PROGRAM_CURRENCY_IMMUTABLE', 'A program currency cannot change', {
        programId: this.id,
        currency: this.currency,
        requested: currency,
      });
    }
  }

  /**
   * Opens a reservation for an approved invoice if the program accepts reservations and has
   * the capacity for it: the only way capacity gets reserved.
   */
  reserve(
    request: ReservationRequest,
    origin: ChangeOrigin,
    now: Date,
  ): ProgramChange & { reservation: Reservation } {
    this.ensureAcceptsReservations();
    const reservation = Reservation.open({
      id: request.reservationId,
      program: this,
      invoiceId: request.invoiceId,
      amount: request.amount,
      rate: request.rate,
      origin,
      now,
    });
    if (reservation.reservedMinor > this.availableMinor) {
      throw new DomainError(
        'INSUFFICIENT_CAPACITY',
        'The program does not have enough available capacity',
        {
          programId: this.id,
          currency: this.currency,
          requested: formatAmount(reservation.reservedMinor, this.currency),
          available: formatAmount(this.availableMinor, this.currency),
        },
      );
    }
    return {
      program: this.with({ reservedMinor: this.reservedMinor + reservation.reservedMinor }),
      reservation,
      ledger: [
        {
          entryType: 'RESERVE',
          reservationId: reservation.id,
          deltaReservedMinor: reservation.reservedMinor,
        },
      ],
    };
  }

  /** Takes back the capacity a release of one of the program's reservations freed. */
  releaseCapacity(release: NewRelease): ProgramChange {
    invariant(
      release.programId === this.id,
      `Release ${release.releaseId} belongs to another program`,
    );
    return {
      program: this.with({ reservedMinor: this.reservedMinor - release.programAmountMinor }),
      ledger: [
        {
          entryType: 'RELEASE',
          reservationId: release.reservationId,
          deltaReservedMinor: -release.programAmountMinor,
        },
      ],
    };
  }

  /** Applies the terms carried by treasury message `sequence`; `changed` if clients see it. */
  applyTerms(terms: ProgramTerms, sequence: number): ProgramChange & { changed: boolean } {
    const program = this.with({ ...terms, treasurySequence: sequence });
    return {
      program,
      changed: program.version !== this.version,
      ledger: limitChange(this.creditLimitMinor, terms.creditLimitMinor),
    };
  }

  /** Records that treasury message `sequence` was applied without changing the program itself. */
  acknowledge(sequence: number): Program {
    return this.with({ treasurySequence: sequence });
  }

  /**
   * Applies a treasury snapshot (ARCHITECTURE.md §4): treasury's terms, the merged reservation
   * states, and the reserved counter re-derived from them, which also heals any drift.
   */
  reconcile(input: {
    snapshot: TreasurySnapshot;
    /** Every ACTIVE reservation of the program plus any reservation named in the snapshot. */
    local: readonly Reservation[];
    graceMs: number;
    origin: ChangeOrigin;
    now: Date;
    /** Identity for reservations known only to treasury. */
    newReservationId: () => string;
  }): Reconciliation {
    const { snapshot, origin, now } = input;
    this.ensureCurrency(snapshot.currency);
    ensureConsistentSnapshot(snapshot.reservations);
    const plan = planReconciliation({
      asOf: snapshot.asOf,
      graceMs: input.graceMs,
      local: input.local,
      snapshot: snapshot.reservations,
    });

    const byId = new Map(input.local.map((reservation) => [reservation.id, reservation]));
    const written = plan.writes.map((write) =>
      write.existingId
        ? byId.get(write.existingId)!.adoptTreasuryState(write)
        : Reservation.importFromTreasury({
            id: input.newReservationId(),
            program: this,
            snapshot: write,
            origin,
            now,
          }),
    );
    const flagged = plan.discrepancies
      .map(({ id }) => byId.get(id)!)
      .filter((reservation) => !reservation.discrepancy)
      .map((reservation) => reservation.flagDiscrepancy());
    const changed = [...written, ...flagged];
    changed.forEach((reservation) => byId.set(reservation.id, reservation));

    let reservedMinor = 0n;
    for (const reservation of byId.values()) {
      reservedMinor += reservation.outstandingMinor;
    }
    const { ledger, driftMinor } = buildReconciliationLedger({
      before: this,
      creditLimitMinor: snapshot.terms.creditLimitMinor,
      writes: plan.writes,
      reservationIds: new Map(
        written.map((reservation) => [reservation.invoiceId, reservation.id]),
      ),
      reservedAfterMinor: reservedMinor,
    });
    return {
      program: this.with({
        ...snapshot.terms,
        reservedMinor,
        treasurySequence: snapshot.sequence,
        lastReconciledAt: now,
      }),
      reservations: changed,
      ledger,
      plan,
      driftMinor,
    };
  }

  /** The state as a plain object, for storage. */
  toState(): ProgramState {
    return {
      id: this.id,
      currency: this.currency,
      creditLimitMinor: this.creditLimitMinor,
      reservedMinor: this.reservedMinor,
      status: this.status,
      version: this.version,
      treasurySequence: this.treasurySequence,
      lastReconciledAt: this.lastReconciledAt,
      updatedAt: this.updatedAt,
    };
  }

  /** The next state; the capacity version moves only when clients can see the difference. */
  private with(changes: Partial<MutableProgramState>): Program {
    const next = { ...this.toState(), ...changes };
    const visible =
      next.creditLimitMinor !== this.creditLimitMinor ||
      next.reservedMinor !== this.reservedMinor ||
      next.status !== this.status ||
      next.lastReconciledAt !== this.lastReconciledAt;
    return new Program({ ...next, version: visible ? this.version + 1 : this.version });
  }
}

export function programNotFound(programId: string): DomainError {
  return new DomainError('PROGRAM_NOT_FOUND', `Program '${programId}' does not exist`, {
    programId,
  });
}

function limitChange(fromMinor: bigint, toMinor: bigint): LedgerEntry[] {
  return toMinor === fromMinor
    ? []
    : [{ entryType: 'LIMIT_CHANGE', deltaCreditLimitMinor: toMinor - fromMinor }];
}
