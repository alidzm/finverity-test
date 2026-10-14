import { Injectable } from '@nestjs/common';
import { DrizzleTransactionManager } from '@/shared/infrastructure/database/drizzle-transaction-manager';
import { outboxEvents } from './messaging.schema';

export interface OutboxEvent {
  /** Partition key of the published message (e.g. the program id). */
  aggregateId: string;
  type: string;
  /** JSON-serialisable payload. */
  payload: Record<string, unknown>;
}

/** Writes an event in the current transaction: it is published if and only if the change commits. */
@Injectable()
export class OutboxWriter {
  constructor(private readonly drizzle: DrizzleTransactionManager) {}

  async enqueue(event: OutboxEvent): Promise<void> {
    await this.drizzle.transaction.insert(outboxEvents).values({
      aggregateId: event.aggregateId,
      eventType: event.type,
      payload: event.payload,
    });
  }
}
