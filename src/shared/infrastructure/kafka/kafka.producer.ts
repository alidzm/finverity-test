import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { KAFKA, type Kafka } from './kafka.client';

export interface OutboundMessage {
  key: string | null;
  value: string | Buffer | null;
  headers?: Record<string, string>;
}

/**
 * Idempotent producer (acks=all, no duplicates on internal retries). Connects lazily so
 * that a process which never produces (e.g. API-only deployment) never opens a connection.
 */
@Injectable()
export class KafkaProducer implements OnApplicationShutdown {
  private readonly producer: KafkaJS.Producer;
  private connecting: Promise<void> | null = null;

  constructor(@Inject(KAFKA) kafka: Kafka) {
    this.producer = kafka.producer({
      'message.timeout.ms': 15_000,
      'linger.ms': 5,
      'compression.type': 'lz4',
      kafkaJS: { idempotent: true, acks: -1 },
    });
  }

  async send(topic: string, messages: OutboundMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.ensureConnected();
    await this.producer.send({ topic, messages });
  }

  private ensureConnected(): Promise<void> {
    this.connecting ??= this.producer.connect().catch((error: unknown) => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.connecting) {
      await this.connecting.catch(() => undefined);
      await this.producer.disconnect();
    }
  }
}
