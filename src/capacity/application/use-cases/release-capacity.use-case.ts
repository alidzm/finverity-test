import { Injectable } from '@nestjs/common';
import { toReleaseDto, toReservationDto } from '@/capacity/application/dto/reservation.dto';
import type { OperationContext } from '@/capacity/application/operation-context';
import { CapacityJournal } from '@/capacity/application/ports/capacity-journal';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { ReservationRepository } from '@/capacity/application/ports/reservation.repository';
import { programNotFound } from '@/capacity/domain/program';
import { type Release, type Reservation, reservationNotFound } from '@/capacity/domain/reservation';
import { TransactionManager } from '@/shared/application/transaction-manager';
import { assertSupportedCurrency } from '@/shared/domain/money/currency';
import { type Amount, parsePositiveAmount } from '@/shared/domain/money/money';

export interface ReleaseCommand {
  programId: string;
  invoiceId: string;
  /** Repayment id: the idempotency key of the release. */
  releaseId: string;
  /** In invoice currency; omitted = release everything still outstanding. */
  amount?: { value: string; currency: string };
}

export interface ReleaseResult {
  release: Release;
  reservation: Reservation;
  /** False when the request replayed an already applied release. */
  created: boolean;
}

/** Releases capacity after a (partial) repayment, at the rate locked on the reservation. */
@Injectable()
export class ReleaseCapacityUseCase {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly programs: ProgramRepository,
    private readonly reservations: ReservationRepository,
    private readonly journal: CapacityJournal,
  ) {}

  async execute(command: ReleaseCommand, context: OperationContext): Promise<ReleaseResult> {
    const requested = command.amount ? parseRequested(command.amount) : undefined;

    const prior = await this.reservations.findRelease(command.programId, command.releaseId);
    if (prior) {
      return this.replay(prior, command.invoiceId, requested);
    }

    return this.transactions.run(async () => {
      // Lock order everywhere: program, then reservation (no deadlocks).
      const program = await this.programs.lockById(command.programId);
      if (!program) {
        throw programNotFound(command.programId);
      }
      // Re-check under the lock: a concurrent request with the same releaseId may have won.
      const priorLocked = await this.reservations.findRelease(program.id, command.releaseId);
      if (priorLocked) {
        return this.replay(priorLocked, command.invoiceId, requested);
      }
      const reservation = await this.reservations.lockByInvoice(program.id, command.invoiceId);
      if (!reservation) {
        throw reservationNotFound(program.id, command.invoiceId);
      }

      const released = reservation.release({
        releaseId: command.releaseId,
        requested,
        origin: context,
        now: new Date(),
      });
      const capacity = program.releaseCapacity(released.release);
      const updatedReservation = await this.reservations.save(released.reservation);
      const release = await this.reservations.insertRelease(released.release);
      const updatedProgram = await this.programs.save(capacity.program);
      await this.journal.record({
        program: updatedProgram,
        ledger: capacity.ledger,
        event: {
          type: 'ReservationReleased',
          payload: {
            release: toReleaseDto(release, updatedReservation),
            reservation: toReservationDto(updatedReservation),
          },
        },
        context,
      });
      return { release, reservation: updatedReservation, created: true };
    });
  }

  private async replay(
    prior: Release,
    invoiceId: string,
    requested?: Amount,
  ): Promise<ReleaseResult> {
    const reservation = (await this.reservations.findById(prior.reservationId))!;
    reservation.ensureSameRelease(prior, invoiceId, requested);
    return { release: prior, reservation, created: false };
  }
}

function parseRequested(amount: { value: string; currency: string }): Amount {
  const currency = assertSupportedCurrency(amount.currency);
  return { minor: parsePositiveAmount(amount.value, currency), currency };
}
