/**
 * Treasury simulator: publishes messages to the inbound topics, exactly as the external
 * treasury system would (contract: docs/ARCHITECTURE.md §3).
 *
 *   pnpm treasury seed
 *   pnpm treasury program <programId> <currency> <creditLimit> [ACTIVE|SUSPENDED]
 *   pnpm treasury fx <BASE> <QUOTE> <rate>
 *   pnpm treasury repayment <programId> <invoiceId> <repaymentId> <amount> <currency>
 *   pnpm treasury snapshot <programId> <snapshot.json>
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KafkaJS } from '@confluentinc/kafka-javascript';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const PROGRAM_TOPIC = process.env.KAFKA_TOPIC_PROGRAM_CAPACITY ?? 'treasury.program-capacity.v1';
const FX_TOPIC = process.env.KAFKA_TOPIC_FX_RATES ?? 'treasury.fx-rates.v1';

type Message = { key: string; value: string };

// Stand-in for treasury's per-program sequence: monotonic across invocations.
let counter = 0;
const nextSequence = () => Date.now() * 1000 + (counter++ % 1000);

function programMessage(type: string, programId: string, payload: unknown): Message {
  return {
    key: programId,
    value: JSON.stringify({
      messageId: randomUUID(),
      type,
      schemaVersion: 1,
      programId,
      sequence: nextSequence(),
      occurredAt: new Date().toISOString(),
      payload,
    }),
  };
}

function fxMessage(base: string, quote: string, rate: string): Message {
  const now = new Date().toISOString();
  return {
    key: `${base}/${quote}`,
    value: JSON.stringify({
      messageId: randomUUID(),
      type: 'FxRateUpdated',
      schemaVersion: 1,
      occurredAt: now,
      payload: { base, quote, rate, asOf: now },
    }),
  };
}

const SEED_PROGRAMS = [
  ['PRG-USD-001', 'USD', '10000000.00'],
  ['PRG-EUR-001', 'EUR', '5000000.00'],
  ['PRG-GBP-001', 'GBP', '2000000.00'],
] as const;

const SEED_RATES = [
  ['EUR', 'USD', '1.0834'],
  ['GBP', 'USD', '1.2710'],
  ['EUR', 'GBP', '0.8524'],
  ['USD', 'JPY', '149.50'],
  ['USD', 'AED', '3.6725'],
] as const;

function plan(args: string[]): { topic: string; messages: Message[] }[] {
  const [command, ...rest] = args;
  switch (command) {
    case 'seed':
      return [
        {
          topic: FX_TOPIC,
          messages: SEED_RATES.map(([base, quote, rate]) => fxMessage(base, quote, rate)),
        },
        {
          topic: PROGRAM_TOPIC,
          messages: SEED_PROGRAMS.map(([programId, currency, creditLimit]) =>
            programMessage('ProgramUpserted', programId, {
              currency,
              creditLimit,
              status: 'ACTIVE',
            }),
          ),
        },
      ];
    case 'program': {
      const [programId, currency, creditLimit, status = 'ACTIVE'] = required(rest, 3);
      return [
        {
          topic: PROGRAM_TOPIC,
          messages: [
            programMessage('ProgramUpserted', programId, { currency, creditLimit, status }),
          ],
        },
      ];
    }
    case 'fx': {
      const [base, quote, rate] = required(rest, 3);
      return [{ topic: FX_TOPIC, messages: [fxMessage(base, quote, rate)] }];
    }
    case 'repayment': {
      const [programId, invoiceId, repaymentId, value, currency] = required(rest, 5);
      return [
        {
          topic: PROGRAM_TOPIC,
          messages: [
            programMessage('RepaymentReceived', programId, {
              invoiceId,
              repaymentId,
              amount: { value, currency },
            }),
          ],
        },
      ];
    }
    case 'snapshot': {
      const [programId, file] = required(rest, 2);
      const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      return [
        {
          topic: PROGRAM_TOPIC,
          messages: [
            programMessage('ProgramReconciled', programId, {
              asOf: new Date().toISOString(),
              status: 'ACTIVE',
              ...snapshot,
            }),
          ],
        },
      ];
    }
    default:
      console.error(
        'Usage: pnpm treasury <seed|program|fx|repayment|snapshot> ...  (see scripts/treasury.ts)',
      );
      process.exit(1);
  }
}

function required(args: string[], count: number): string[] {
  if (args.length < count) {
    console.error(`Expected at least ${count} arguments, got ${args.length}`);
    process.exit(1);
  }
  return args;
}

const batches = plan(process.argv.slice(2));
const producer = new KafkaJS.Kafka({
  kafkaJS: { brokers, logLevel: KafkaJS.logLevel.ERROR },
}).producer({
  kafkaJS: { idempotent: true, acks: -1 },
});
await producer.connect();
try {
  for (const { topic, messages } of batches) {
    await producer.send({ topic, messages });
    for (const message of messages) {
      console.log(`→ ${topic} [${message.key}] ${message.value}`);
    }
  }
} finally {
  await producer.disconnect();
}
