import { Global, Module } from '@nestjs/common';
import { MessageDeduplicator } from '@/shared/application/messaging/message-deduplicator';
import { MessageInbox } from '@/shared/application/messaging/message-inbox';
import { DrizzleMessageInbox } from './drizzle-message-inbox';
import { OutboxRelay } from './outbox.relay';
import { OutboxWriter } from './outbox.writer';

/** Reliable messaging building blocks: transactional inbox (dedupe) and outbox (publish). */
@Global()
@Module({
  providers: [
    { provide: MessageInbox, useClass: DrizzleMessageInbox },
    MessageDeduplicator,
    OutboxWriter,
    OutboxRelay,
  ],
  exports: [MessageInbox, MessageDeduplicator, OutboxWriter, OutboxRelay],
})
export class MessagingModule {}
