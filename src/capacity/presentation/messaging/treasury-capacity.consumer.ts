import { Injectable, Logger } from '@nestjs/common';
import { treasuryContext } from '@/capacity/application/operation-context';
import { ApplyRepaymentUseCase } from '@/capacity/application/use-cases/apply-repayment.use-case';
import { ReconcileProgramUseCase } from '@/capacity/application/use-cases/reconcile-program.use-case';
import { UpsertProgramUseCase } from '@/capacity/application/use-cases/upsert-program.use-case';
import { AppConfig } from '@/config/app-config';
import {
  type InboundMessage,
  MessageConsumer,
  type MessageHandler,
} from '@/shared/application/messaging/inbound-message';
import { MessageDeduplicator } from '@/shared/application/messaging/message-deduplicator';
import { assertSupportedCurrency } from '@/shared/domain/money/currency';
import { decodeMessage } from '@/shared/presentation/messaging/decode-message';
import {
  type ProgramCapacityMessage,
  ProgramCapacityMessageSchema,
} from './treasury-capacity.messages';

/**
 * Inbound adapter (anti-corruption layer) for `treasury.program-capacity.v1`: validates the
 * external contract, dedupes by message id and translates each message into a use case,
 * so the treasury format never leaks into the domain.
 */
@MessageConsumer()
@Injectable()
export class TreasuryCapacityConsumer implements MessageHandler {
  private readonly logger = new Logger(TreasuryCapacityConsumer.name);
  readonly topic: string;

  constructor(
    config: AppConfig,
    private readonly deduplicator: MessageDeduplicator,
    private readonly upsertProgram: UpsertProgramUseCase,
    private readonly applyRepayment: ApplyRepaymentUseCase,
    private readonly reconcileProgram: ReconcileProgramUseCase,
  ) {
    this.topic = config.kafka.topics.programCapacity;
  }

  async handle(message: InboundMessage): Promise<void> {
    const decoded = decodeMessage(message, ProgramCapacityMessageSchema);
    if (message.key !== null && message.key !== decoded.programId) {
      // Ordering is only guaranteed per partition key; a mismatch means a producer bug.
      this.logger.warn(
        { key: message.key, programId: decoded.programId },
        'Message key does not match programId',
      );
    }
    const outcome = await this.deduplicator.processOnce(
      {
        messageId: decoded.messageId,
        topic: message.topic,
        partition: message.partition,
        offset: message.offset,
        messageType: decoded.type,
      },
      () => this.dispatch(decoded),
    );
    this.logger.log(
      { programId: decoded.programId, sequence: decoded.sequence, type: decoded.type, outcome },
      'Treasury message processed',
    );
  }

  private async dispatch(message: ProgramCapacityMessage): Promise<string> {
    const { programId, sequence } = message;
    const context = treasuryContext(message.messageId);
    switch (message.type) {
      case 'ProgramUpserted':
        return this.upsertProgram.execute(
          {
            programId,
            sequence,
            currency: assertSupportedCurrency(message.payload.currency),
            creditLimit: message.payload.creditLimit,
            status: message.payload.status,
          },
          context,
        );
      case 'RepaymentReceived':
        return this.applyRepayment.execute(
          {
            programId,
            sequence,
            invoiceId: message.payload.invoiceId,
            repaymentId: message.payload.repaymentId,
            amount: message.payload.amount,
          },
          context,
        );
      case 'ProgramReconciled': {
        const summary = await this.reconcileProgram.execute(
          {
            programId,
            sequence,
            asOf: new Date(message.payload.asOf),
            currency: assertSupportedCurrency(message.payload.currency),
            creditLimit: message.payload.creditLimit,
            status: message.payload.status,
            reservations: message.payload.reservations,
          },
          context,
        );
        return summary.outcome;
      }
    }
  }
}
