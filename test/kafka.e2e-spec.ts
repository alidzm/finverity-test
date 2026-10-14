import { randomUUID } from 'node:crypto';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { KafkaConsumerRunner } from '@/shared/infrastructure/kafka/kafka-consumer.runner';
import { assertInvariants, nextSequence } from './support/fixtures';
import { collect, createTopics, eventually, testKafka } from './support/kafka';
import { createTestApp, type TestApp, uniqueId } from './support/test-app';

describe('Treasury integration over Kafka', () => {
  const suffix = randomUUID().slice(0, 8);
  const topics = {
    program: `treasury.program-capacity.${suffix}`,
    fx: `treasury.fx-rates.${suffix}`,
    events: `capacity.events.${suffix}`,
  };
  let kafka: KafkaJS.Kafka;
  let producer: KafkaJS.Producer;
  let t: TestApp;

  beforeAll(async () => {
    kafka = testKafka();
    await createTopics(kafka, [
      topics.program,
      `${topics.program}.dlq`,
      topics.fx,
      `${topics.fx}.dlq`,
      topics.events,
    ]);
    producer = kafka.producer();
    await producer.connect();
    t = await createTestApp({
      CONSUMERS_ENABLED: 'true',
      OUTBOX_RELAY_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: '100',
      KAFKA_CONSUMER_GROUP: `capacity-test-${suffix}`,
      KAFKA_TOPIC_PROGRAM_CAPACITY: topics.program,
      KAFKA_TOPIC_FX_RATES: topics.fx,
      KAFKA_TOPIC_CAPACITY_EVENTS: topics.events,
    });
    await eventually(() => expect(t.app.get(KafkaConsumerRunner).isRunning).toBe(true));
  });
  afterAll(async () => {
    await t.close();
    await producer.disconnect();
  });

  const programMessage = (
    type: string,
    programId: string,
    payload: object,
    messageId = randomUUID(),
  ) => ({
    key: programId,
    value: JSON.stringify({
      messageId,
      type,
      schemaVersion: 1,
      programId,
      sequence: nextSequence(),
      occurredAt: new Date().toISOString(),
      payload,
    }),
  });
  const send = (topic: string, ...messages: { key: string; value: string }[]) =>
    producer.send({ topic, messages });
  const get = (path: string) => t.http.get(path).set('Authorization', t.auth);

  it('applies programs, FX rates and repayments from treasury exactly once', async () => {
    const programId = uniqueId('PRG');
    const now = new Date().toISOString();
    // A pair no other test file touches (the fx_rates table is shared between files).
    await send(topics.fx, {
      key: 'SGD/USD',
      value: JSON.stringify({
        messageId: randomUUID(),
        type: 'FxRateUpdated',
        schemaVersion: 1,
        occurredAt: now,
        payload: { base: 'SGD', quote: 'USD', rate: '0.75', asOf: now },
      }),
    });
    await send(
      topics.program,
      programMessage('ProgramUpserted', programId, {
        currency: 'USD',
        creditLimit: '100000.00',
        status: 'ACTIVE',
      }),
    );
    await eventually(async () =>
      expect((await get(`/v1/programs/${programId}/capacity`)).status).toBe(200),
    );

    await eventually(async () => {
      const reserved = await t.http
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', t.auth)
        .send({ invoiceId: 'INV-1', amount: { value: '1000.00', currency: 'SGD' } });
      expect(reserved.status).toBe(201); // retried until the FX message has been applied
    });
    expect((await get(`/v1/programs/${programId}/capacity`)).body.reserved).toBe('750.00');

    // The same repayment delivered twice (same messageId) is applied once.
    const repayment = programMessage('RepaymentReceived', programId, {
      invoiceId: 'INV-1',
      repaymentId: 'RPM-1',
      amount: { value: '400.00', currency: 'SGD' },
    });
    await send(topics.program, repayment, repayment);
    await eventually(async () => {
      const reservation = (await get(`/v1/programs/${programId}/reservations/INV-1`)).body;
      expect(reservation.releases).toHaveLength(1);
      expect(reservation.outstandingAmount.value).toBe('450.00');
    });

    // A limit change arrives on the same ordered stream.
    await send(
      topics.program,
      programMessage('ProgramUpserted', programId, {
        currency: 'USD',
        creditLimit: '50000.00',
        status: 'ACTIVE',
      }),
    );
    await eventually(async () =>
      expect((await get(`/v1/programs/${programId}/capacity`)).body.available).toBe('49550.00'),
    );
    await assertInvariants(t.app, programId);
  });

  it('sends unprocessable messages to the DLQ and keeps consuming', async () => {
    const dlq = await collect(kafka, `${topics.program}.dlq`, `dlq-reader-${suffix}`);
    try {
      const programId = uniqueId('PRG');
      await send(
        topics.program,
        { key: 'garbage', value: '{not json' },
        programMessage('ProgramUpserted', programId, {
          currency: 'USD',
          creditLimit: '-5',
          status: 'ACTIVE',
        }),
        programMessage('RepaymentReceived', programId, {
          invoiceId: 'INV-404',
          repaymentId: 'RPM-1',
          amount: { value: '1.00', currency: 'USD' },
        }),
        programMessage('ProgramUpserted', programId, {
          currency: 'USD',
          creditLimit: '10.00',
          status: 'ACTIVE',
        }),
      );

      // The valid message behind the poison ones is still applied …
      await eventually(async () =>
        expect((await get(`/v1/programs/${programId}/capacity`)).status).toBe(200),
      );
      // … and the three bad ones are parked with diagnostics.
      await eventually(() => expect(dlq.messages.length).toBeGreaterThanOrEqual(3));
      const reasons = dlq.messages.map((message) => message.headers['x-dlq-reason']);
      expect(reasons.some((reason) => reason.includes('not valid JSON'))).toBe(true);
      expect(reasons.some((reason) => reason.includes('Schema validation failed'))).toBe(true);
      expect(
        dlq.messages.some((message) => message.headers['x-dlq-error-code'] === 'PROGRAM_NOT_FOUND'),
      ).toBe(true);
      expect(dlq.messages[0].headers['x-dlq-original-topic']).toBe(topics.program);
    } finally {
      await dlq.stop();
    }
  });

  it('publishes capacity events through the transactional outbox', async () => {
    const events = await collect(kafka, topics.events, `events-reader-${suffix}`);
    try {
      const programId = uniqueId('PRG');
      await send(
        topics.program,
        programMessage('ProgramUpserted', programId, {
          currency: 'USD',
          creditLimit: '1000.00',
          status: 'ACTIVE',
        }),
      );
      await eventually(async () =>
        expect((await get(`/v1/programs/${programId}/capacity`)).status).toBe(200),
      );
      await t.http
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', t.auth)
        .send({ invoiceId: 'INV-1', amount: { value: '250.00', currency: 'USD' } })
        .expect(201);

      const published = await eventually(() => {
        const mine = events.messages
          .filter((message) => message.key === programId)
          .map((m) => JSON.parse(m.value));
        expect(mine.map((event) => event.type)).toEqual([
          'ProgramCapacityUpdated',
          'ReservationCreated',
        ]);
        return mine;
      });
      expect(published[1]).toMatchObject({
        programId,
        schemaVersion: 1,
        payload: {
          reservation: { invoiceId: 'INV-1' },
          capacity: { reserved: '250.00', available: '750.00' },
        },
      });
    } finally {
      await events.stop();
    }
  });
});
