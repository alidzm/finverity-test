import { Injectable } from '@nestjs/common';
import { type InboxRef, MessageInbox } from '@/shared/application/messaging/message-inbox';
import { DrizzleTransactionManager } from '@/shared/infrastructure/database/drizzle-transaction-manager';
import { inboxMessages } from './messaging.schema';

@Injectable()
export class DrizzleMessageInbox extends MessageInbox {
  constructor(private readonly drizzle: DrizzleTransactionManager) {
    super();
  }

  async tryRecord(ref: InboxRef): Promise<boolean> {
    const inserted = await this.drizzle.transaction
      .insert(inboxMessages)
      .values(ref)
      .onConflictDoNothing({ target: inboxMessages.messageId })
      .returning({ messageId: inboxMessages.messageId });
    return inserted.length > 0;
  }
}
