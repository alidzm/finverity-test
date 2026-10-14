import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '@/config/app-config';

export const KAFKA = Symbol('KAFKA');
export type Kafka = KafkaJS.Kafka;

export function createKafka(config: AppConfig): Kafka {
  const { brokers, clientId, ssl, sasl } = config.kafka;
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers,
      clientId,
      ssl,
      // The client inspects the key's presence, so it must be absent rather than undefined.
      ...(sasl ? { sasl: sasl as KafkaJS.SASLOptions } : {}),
      logLevel: KafkaJS.logLevel.WARN,
      logger: nestLogger('Kafka'),
    },
  });
}

/** Routes client logs through the application logger (structured JSON in production). */
function nestLogger(context: string): KafkaJS.Logger {
  const logger = new Logger(context);
  let level = KafkaJS.logLevel.WARN;
  const adapter: KafkaJS.Logger = {
    error: (message, extra) =>
      level >= KafkaJS.logLevel.ERROR && logger.error({ ...extra }, message),
    warn: (message, extra) => level >= KafkaJS.logLevel.WARN && logger.warn({ ...extra }, message),
    info: (message, extra) => level >= KafkaJS.logLevel.INFO && logger.log({ ...extra }, message),
    debug: (message, extra) =>
      level >= KafkaJS.logLevel.DEBUG && logger.debug({ ...extra }, message),
    namespace: (namespace) => nestLogger(`${context}:${namespace}`),
    setLogLevel: (newLevel) => {
      level = newLevel;
    },
  };
  return adapter;
}
