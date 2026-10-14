import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { toReservationDto } from '@/capacity/application/dto/reservation.dto';
import type { OperationContext } from '@/capacity/application/operation-context';
import { CapacityJournal } from '@/capacity/application/ports/capacity-journal';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { ReservationRepository } from '@/capacity/application/ports/reservation.repository';
import { programNotFound } from '@/capacity/domain/program';
import type { Reservation } from '@/capacity/domain/reservation';
import { FxRateService } from '@/fx/application/fx-rate.service';
import { TransactionManager } from '@/shared/application/transaction-manager';
import { assertSupportedCurrency } from '@/shared/domain/money/currency';
import { type Amount, parsePositiveAmount } from '@/shared/domain/money/money';

export interface ReserveCommand {
  programId: string;
  invoiceId: string;
  amount: { value: string; currency: string };
}

export interface ReserveResult {
  reservation: Reservation;
  /** False when the request replayed an identical, already existing reservation. */
  created: boolean;
}

/** Reserves program capacity for an approved invoice. */
@Injectable()
export class ReserveCapacityUseCase {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly programs: ProgramRepository,
    private readonly reservations: ReservationRepository,
    private readonly fx: FxRateService,
    private readonly journal: CapacityJournal,
  ) {}

  async execute(command: ReserveCommand, context: OperationContext): Promise<ReserveResult> {
    const currency = assertSupportedCurrency(command.amount.currency);
    const requested: Amount = {
      minor: parsePositiveAmount(command.amount.value, currency),
      currency,
    };

    // Idempotency by natural key: an invoice reserves at most once per program. Replays are
    // answered without taking the program lock.
    const existing = await this.reservations.findByInvoice(command.programId, command.invoiceId);
    if (existing) {
      return { reservation: existing.ensureSameRequest(requested), created: false };
    }

    const program = await this.programs.findById(command.programId);
    if (!program) {
      throw programNotFound(command.programId);
    }
    program.ensureAcceptsReservations();
    // Quoted outside the lock: the program currency never changes.
    const rate = await this.fx.quote(currency, program.currency);

    return this.transactions.run(async () => {
      // The program row is the per-program mutex: decisions are made on its current state.
      const current = (await this.programs.lockById(program.id))!;
      // A concurrent request for the same invoice may have committed while we waited.
      const winner = await this.reservations.findByInvoice(program.id, command.invoiceId);
      if (winner) {
        return { reservation: winner.ensureSameRequest(requested), created: false };
      }

      const change = current.reserve(
        { reservationId: randomUUID(), invoiceId: command.invoiceId, amount: requested, rate },
        context,
        new Date(),
      );
      const reservation = await this.reservations.save(change.reservation);
      const updated = await this.programs.save(change.program);
      await this.journal.record({
        program: updated,
        ledger: change.ledger,
        event: {
          type: 'ReservationCreated',
          payload: { reservation: toReservationDto(reservation) },
        },
        context,
      });
      return { reservation, created: true };
    });
  }
}
