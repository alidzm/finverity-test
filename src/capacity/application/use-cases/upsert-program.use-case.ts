import { Injectable } from '@nestjs/common';
import type { OperationContext } from '@/capacity/application/operation-context';
import { CapacityJournal } from '@/capacity/application/ports/capacity-journal';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { Program, type ProgramStatus, type ProgramTerms } from '@/capacity/domain/program';
import { TransactionManager } from '@/shared/application/transaction-manager';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { formatAmount, parseAmount } from '@/shared/domain/money/money';
import type { SyncOutcome } from './sync-outcome';

export interface UpsertProgramCommand {
  programId: string;
  sequence: number;
  currency: CurrencyCode;
  creditLimit: string;
  status: ProgramStatus;
}

/** Creates a program or applies new treasury terms (limit, status) to it. */
@Injectable()
export class UpsertProgramUseCase {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly programs: ProgramRepository,
    private readonly journal: CapacityJournal,
  ) {}

  async execute(command: UpsertProgramCommand, context: OperationContext): Promise<SyncOutcome> {
    const terms: ProgramTerms = {
      creditLimitMinor: parseAmount(command.creditLimit, command.currency),
      status: command.status,
    };

    return this.transactions.run(async () => {
      const announced = Program.create(
        {
          id: command.programId,
          currency: command.currency,
          terms,
          treasurySequence: command.sequence,
        },
        new Date(),
      );
      const created = await this.programs.insertIfAbsent(announced.program);
      if (created) {
        await this.journal.record({
          program: created,
          ledger: announced.ledger,
          event: { type: 'ProgramCapacityUpdated', payload: { change: 'CREATED' } },
          context,
        });
        return 'APPLIED';
      }

      const program = (await this.programs.lockById(command.programId))!;
      if (program.hasApplied(command.sequence)) {
        return 'STALE';
      }
      program.ensureCurrency(command.currency);
      const change = program.applyTerms(terms, command.sequence);
      const updated = await this.programs.save(change.program);
      if (change.changed) {
        await this.journal.record({
          program: updated,
          ledger: change.ledger,
          event: {
            type: 'ProgramCapacityUpdated',
            payload: {
              change: 'UPDATED',
              previousCreditLimit: formatAmount(program.creditLimitMinor, program.currency),
              previousStatus: program.status,
            },
          },
          context,
        });
      }
      return 'APPLIED';
    });
  }
}
