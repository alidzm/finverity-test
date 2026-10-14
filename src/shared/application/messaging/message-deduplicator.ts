import { Injectable } from '@nestjs/common';
import { TransactionManager } from '@/shared/application/transaction-manager';
import { type InboxRef, MessageInbox } from './message-inbox';

export const DUPLICATE = 'DUPLICATE';

/**
 * Idempotent-consumer helper for inbound adapters: runs `work` at most once per message id.
 * The inbox entry and everything `work` writes commit (or roll back) in one transaction;
 * use cases opened inside it join that transaction.
 */
@Injectable()
export class MessageDeduplicator {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly inbox: MessageInbox,
  ) {}

  processOnce<T>(ref: InboxRef, work: () => Promise<T>): Promise<T | typeof DUPLICATE> {
    return this.transactions.run(async () =>
      (await this.inbox.tryRecord(ref)) ? work() : DUPLICATE,
    );
  }
}
