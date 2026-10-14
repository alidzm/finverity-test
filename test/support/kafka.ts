import { KafkaJS } from '@confluentinc/kafka-javascript';
import { inject } from 'vitest';

export interface CollectedMessage {
  key: string | null;
  value: string;
  headers: Record<string, string>;
}

export function testKafka(): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: { brokers: [inject('kafkaBrokers')], logLevel: KafkaJS.logLevel.NOTHING },
  });
}

export async function createTopics(kafka: KafkaJS.Kafka, topics: string[]): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: topics.map((topic) => ({ topic, numPartitions: 3 })) });
  } finally {
    await admin.disconnect();
  }
}

/** Consumes a topic from the beginning into an array until `stop()` is called. */
export async function collect(
  kafka: KafkaJS.Kafka,
  topic: string,
  groupId: string,
): Promise<{ messages: CollectedMessage[]; stop: () => Promise<void> }> {
  const messages: CollectedMessage[] = [];
  const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true } });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(message.headers ?? {})) {
        if (value !== undefined) {
          headers[name] = (Array.isArray(value) ? value[0] : value).toString();
        }
      }
      messages.push({
        key: message.key?.toString() ?? null,
        value: message.value?.toString() ?? '',
        headers,
      });
    },
  });
  return { messages, stop: () => consumer.disconnect() };
}

/** Retries an assertion until it passes or the timeout elapses. */
export async function eventually<T>(
  assertion: () => Promise<T> | T,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
