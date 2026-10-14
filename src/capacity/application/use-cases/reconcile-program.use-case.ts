import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { OperationContext } from '@/capacity/application/operation-context';
import { CapacityJournal } from '@/capacity/application/ports/capacity-journal';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { ReservationRepository } from '@/capacity/application/ports/reservation.repository';
import { Program, type ProgramStatus, type TreasurySnapshot } from '@/capacity/domain/program';
import type { SnapshotReservation } from '@/capacity/domain/reservation';
import { AppConfig } from '@/config/app-config';
import { TransactionManager } from '@/shared/application/transaction-manager';
import { assertSupportedCurrency, type CurrencyCode } from '@/shared/domain/money/currency';
import { formatAmount, parseAmount, parsePositiveAmount } from '@/shared/domain/money/money';
import type { SyncOutcome } from './sync-outcome';

export interface SnapshotReservationInput {
  invoiceId: string;
  invoiceAmount: { value: string; currency: string };
  /** Program currency. */
  reservedAmount: string;
  /** Program currency. */
  releasedAmount: string;
  /** Invoice currency. */
  releasedInvoiceAmount: string;
}

export interface ReconcileProgramCommand {
  programId: string;
  sequence: number;
  asOf: Date;
  currency: CurrencyCode;
  creditLimit: string;
  status: ProgramStatus;
  reservations: SnapshotReservationInput[];
}

export interface ReconciliationSummary {
  outcome: SyncOutcome;
  written?: number;
  discrepancies?: string[];
  keptNewerLocal?: number;
  keptInFlight?: number;
  /** Difference between the materialised counter and the recomputed sum (should be 0). */
  driftMinor?: bigint;
}

/** Applies a full treasury snapshot to one program (ARCHITECTURE.md §4). */
@Injectable()
export class ReconcileProgramUseCase {
  private readonly logger = new Logger(ReconcileProgramUseCase.name);

  constructor(
    private readonly config: AppConfig,
    private readonly transactions: TransactionManager,
    private readonly programs: ProgramRepository,
    private readonly reservations: ReservationRepository,
    private readonly journal: CapacityJournal,
  ) {}

  async execute(
    command: ReconcileProgramCommand,
    context: OperationContext,
  ): Promise<ReconciliationSummary> {
    // Parse the whole snapshot before taking any lock.
    const snapshot: TreasurySnapshot = {
      sequence: command.sequence,
      asOf: command.asOf,
      currency: command.currency,
      terms: {
        creditLimitMinor: parseAmount(command.creditLimit, command.currency),
        status: command.status,
      },
      reservations: parseReservations(command),
    };

    return this.transactions.run(async () => {
      const now = new Date();
      // A snapshot may introduce a program; its initial limit is journaled as a change from 0.
      await this.programs.insertIfAbsent(
        Program.create(
          {
            id: command.programId,
            currency: command.currency,
            terms: { creditLimitMinor: 0n, status: command.status },
            treasurySequence: 0,
          },
          now,
        ).program,
      );
      const program = (await this.programs.lockById(command.programId))!;
      if (program.hasApplied(command.sequence)) {
        return { outcome: 'STALE' };
      }

      const local = await this.reservations.findForReconciliation(
        program.id,
        snapshot.reservations.map((item) => item.invoiceId),
      );
      const reconciliation = program.reconcile({
        snapshot,
        local,
        graceMs: this.config.reconciliation.graceMs,
        origin: context,
        now,
        newReservationId: randomUUID,
      });
      await this.reservations.saveAll(reconciliation.reservations);
      const updated = await this.programs.save(reconciliation.program);

      const { plan, driftMinor } = reconciliation;
      const discrepancies = plan.discrepancies.map((item) => item.invoiceId);
      await this.journal.record({
        program: updated,
        ledger: reconciliation.ledger,
        event: {
          type: 'ProgramReconciled',
          payload: {
            sequence: command.sequence,
            asOf: command.asOf.toISOString(),
            written: plan.writes.length,
            keptNewerLocal: plan.keptNewerLocal.length,
            keptInFlight: plan.keptInFlight.length,
            discrepancies,
            drift: formatAmount(driftMinor, program.currency),
          },
        },
        context,
      });

      if (discrepancies.length > 0 || driftMinor !== 0n) {
        this.logger.warn(
          {
            programId: program.id,
            discrepancies: discrepancies.slice(0, 50),
            driftMinor: driftMinor.toString(),
          },
          'Reconciliation found discrepancies',
        );
      }
      return {
        outcome: 'APPLIED',
        written: plan.writes.length,
        discrepancies,
        keptNewerLocal: plan.keptNewerLocal.length,
        keptInFlight: plan.keptInFlight.length,
        driftMinor,
      };
    });
  }
}

/** Maps the command's decimal strings into exact domain amounts. */
function parseReservations(command: ReconcileProgramCommand): SnapshotReservation[] {
  return command.reservations.map((item) => {
    const invoiceCurrency = assertSupportedCurrency(item.invoiceAmount.currency);
    return {
      invoiceId: item.invoiceId,
      invoiceCurrency,
      invoiceAmountMinor: parsePositiveAmount(item.invoiceAmount.value, invoiceCurrency),
      reservedMinor: parseAmount(item.reservedAmount, command.currency),
      releasedMinor: parseAmount(item.releasedAmount, command.currency),
      releasedInvoiceMinor: parseAmount(item.releasedInvoiceAmount, invoiceCurrency),
    };
  });
}
