import { Injectable } from '@nestjs/common';
import type { OperationContext } from '@/capacity/application/operation-context';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { programNotFound } from '@/capacity/domain/program';
import { TransactionManager } from '@/shared/application/transaction-manager';
import { ReleaseCapacityUseCase } from './release-capacity.use-case';
import type { SyncOutcome } from './sync-outcome';

export interface ApplyRepaymentCommand {
  programId: string;
  sequence: number;
  invoiceId: string;
  repaymentId: string;
  /** In invoice currency. */
  amount: { value: string; currency: string };
}

/**
 * A repayment reported by treasury: the same release as through the API (keyed by the
 * repayment id, so a repayment arriving through both channels is applied once), guarded
 * by the per-program treasury sequence.
 */
@Injectable()
export class ApplyRepaymentUseCase {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly programs: ProgramRepository,
    private readonly releaseCapacity: ReleaseCapacityUseCase,
  ) {}

  execute(command: ApplyRepaymentCommand, context: OperationContext): Promise<SyncOutcome> {
    return this.transactions.run(async () => {
      const program = await this.programs.lockById(command.programId);
      if (!program) {
        throw programNotFound(command.programId);
      }
      if (program.hasApplied(command.sequence)) {
        return 'STALE';
      }
      // Stored before the release, which reads the program again under its own lock; saving
      // this instance afterwards would overwrite the release with a stale state.
      await this.programs.save(program.acknowledge(command.sequence));
      // Joins this transaction (savepoint) and re-takes the program lock it already holds.
      await this.releaseCapacity.execute(
        {
          programId: program.id,
          invoiceId: command.invoiceId,
          releaseId: command.repaymentId,
          amount: command.amount,
        },
        context,
      );
      return 'APPLIED';
    });
  }
}
