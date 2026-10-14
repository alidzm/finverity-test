import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppConfig } from '@/config/app-config';
import {
  type InboundMessage,
  MessageConsumer,
  type MessageHandler,
} from '@/shared/application/messaging/inbound-message';
import { DomainError } from '@/shared/domain/domain-error';
import { KAFKA, type Kafka } from './kafka.client';
import { KafkaProducer } from './kafka.producer';
import { isNonRetryable } from './retry-policy';

const IN_PROCESS_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 5_000;
const RECONNECT_DELAY_MS = 5_000;

/**
 * Kafka transport for every provider decorated with `@MessageConsumer()`, in one
 * consumer group.
 *
 * Delivery semantics: offsets are committed manually, only after the handler (and its
 * database transaction) succeeded → at-least-once; handlers dedupe via the inbox table.
 *
 * Errors:
 * - non-retryable → the message is copied to `<topic><dlqSuffix>` and its offset committed;
 * - transient → retried in place with exponential backoff; after a few attempts the error
 *   is rethrown, which makes the client seek back and redeliver the same message. Retries
 *   are blocking on purpose: skipping ahead would break per-program ordering.
 */
@Injectable()
export class KafkaConsumerRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerRunner.name);
  private handlersByTopic = new Map<string, MessageHandler>();
  private consumer?: KafkaJS.Consumer;
  private stopping = false;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    @Inject(KAFKA) private readonly kafka: Kafka,
    private readonly producer: KafkaProducer,
    private readonly discovery: DiscoveryService,
  ) {}

  get enabled(): boolean {
    return this.config.kafka.consumersEnabled && this.handlersByTopic.size > 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  onApplicationBootstrap(): void {
    const handlers = this.discovery
      .getProviders({ metadataKey: MessageConsumer.KEY })
      .map((wrapper) => wrapper.instance as MessageHandler | undefined)
      .filter((handler): handler is MessageHandler => handler !== undefined);
    this.handlersByTopic = new Map(handlers.map((handler) => [handler.topic, handler]));

    if (!this.enabled) {
      this.logger.log('Kafka consumers disabled');
      return;
    }
    // Started in the background: the HTTP API must not depend on broker availability.
    void this.startWithRetry();
  }

  private async startWithRetry(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.start();
        return;
      } catch (error) {
        this.logger.warn(
          { err: error },
          `Kafka consumer failed to start; retrying in ${RECONNECT_DELAY_MS}ms`,
        );
        await this.consumer?.disconnect().catch(() => undefined);
        this.consumer = undefined;
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  private async start(): Promise<void> {
    const consumer = this.kafka.consumer({
      kafkaJS: {
        groupId: this.config.kafka.consumerGroup,
        fromBeginning: true,
        autoCommit: false,
        sessionTimeout: 30_000,
      },
    });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topics: [...this.handlersByTopic.keys()] });
    await consumer.run({
      // Partitions are processed in parallel; messages within a partition stay sequential.
      partitionsConsumedConcurrently: 4,
      eachMessage: (payload) => this.process(consumer, payload),
    });
    this.running = true;
    this.logger.log(`Consuming ${[...this.handlersByTopic.keys()].join(', ')}`);
  }

  private async process(
    consumer: KafkaJS.Consumer,
    payload: KafkaJS.EachMessagePayload,
  ): Promise<void> {
    const { topic, partition, message } = payload;
    const inbound: InboundMessage = {
      topic,
      partition,
      offset: message.offset,
      key: message.key?.toString('utf8') ?? null,
      value: message.value,
      headers: normalizeHeaders(message.headers),
    };
    const handler = this.handlersByTopic.get(topic)!;
    const position = { topic, partition, offset: message.offset };

    try {
      await this.withRetry(() => handler.handle(inbound), position);
    } catch (error) {
      if (!isNonRetryable(error)) {
        this.logger.error(
          { err: error, ...position },
          'Message processing failed; will be redelivered',
        );
        throw error;
      }
      await this.sendToDeadLetterQueue(inbound, error);
    }
    await consumer.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }

  private async withRetry(
    work: () => Promise<void>,
    position: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await work();
        return;
      } catch (error) {
        if (isNonRetryable(error) || attempt >= IN_PROCESS_ATTEMPTS || this.stopping) {
          throw error;
        }
        const delay =
          Math.min(MAX_BACKOFF_MS, 200 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
        this.logger.warn(
          { err: error, attempt, ...position },
          `Transient failure; retrying in ${Math.round(delay)}ms`,
        );
        await sleep(delay);
      }
    }
  }

  private async sendToDeadLetterQueue(message: InboundMessage, error: unknown): Promise<void> {
    const dlqTopic = `${message.topic}${this.config.kafka.dlqSuffix}`;
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      { topic: message.topic, partition: message.partition, offset: message.offset, reason },
      `Message sent to ${dlqTopic}`,
    );
    await this.producer.send(dlqTopic, [
      {
        key: message.key,
        value: message.value,
        headers: {
          ...message.headers,
          'x-dlq-reason': reason.slice(0, 1_000),
          'x-dlq-error-code':
            error instanceof DomainError ? error.code : ((error as Error)?.name ?? 'Error'),
          'x-dlq-original-topic': message.topic,
          'x-dlq-original-partition': String(message.partition),
          'x-dlq-original-offset': message.offset,
          'x-dlq-failed-at': new Date().toISOString(),
        },
      },
    ]);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.running = false;
    await this.consumer?.disconnect();
  }
}

function normalizeHeaders(headers: KafkaJS.IHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) {
      result[name] = first.toString();
    }
  }
  return result;
}
