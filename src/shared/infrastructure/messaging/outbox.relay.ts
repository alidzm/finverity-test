import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { asc, inArray, isNull, sql } from 'drizzle-orm';
import { AppConfig } from '@/config/app-config';
import { DrizzleTransactionManager } from '@/shared/infrastructure/database/drizzle-transaction-manager';
import { KafkaProducer } from '@/shared/infrastructure/kafka/kafka.producer';
import { outboxEvents } from './messaging.schema';

/** Arbitrary constant identifying the relay leadership advisory lock. */
const RELAY_LOCK_ID = 7_316_204_119;

/**
 * Publishes committed outbox events to Kafka in insertion order (at-least-once; consumers
 * dedupe by `eventId`). A transaction-scoped advisory lock makes sure that only one
 * instance publishes at a time, which preserves ordering across horizontally scaled pods.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private current: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly drizzle: DrizzleTransactionManager,
    private readonly producer: KafkaProducer,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.outbox.relayEnabled) {
      this.schedule(0);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.current = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let delay = this.config.outbox.pollIntervalMs;
    try {
      const published = await this.publishBatch();
      if (published === this.config.outbox.batchSize) {
        delay = 0; // backlog: keep draining
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Outbox publish failed; will retry');
      delay = Math.min(delay * 10, 10_000);
    }
    this.schedule(delay);
  }

  /** Publishes one batch; returns the number of events published. */
  publishBatch(): Promise<number> {
    return this.drizzle.run(async () => {
      const tx = this.drizzle.transaction;
      const lock = await tx.execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(${RELAY_LOCK_ID}) as acquired`,
      );
      if (!lock.rows[0]?.acquired) {
        return 0;
      }
      const batch = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        .orderBy(asc(outboxEvents.id))
        .limit(this.config.outbox.batchSize);
      if (batch.length === 0) {
        return 0;
      }

      await this.producer.send(
        this.config.kafka.topics.capacityEvents,
        batch.map((event) => ({
          key: event.aggregateId,
          value: JSON.stringify({
            eventId: event.eventId,
            type: event.eventType,
            schemaVersion: 1,
            programId: event.aggregateId,
            occurredAt: event.createdAt.toISOString(),
            payload: event.payload,
          }),
          headers: { 'event-type': event.eventType, 'event-id': event.eventId },
        })),
      );
      await tx
        .update(outboxEvents)
        .set({ publishedAt: sql`now()` })
        .where(
          inArray(
            outboxEvents.id,
            batch.map((event) => event.id),
          ),
        );
      return batch.length;
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }
}
