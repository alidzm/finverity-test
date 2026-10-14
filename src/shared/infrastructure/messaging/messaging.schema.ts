import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

/** Kafka messages already applied (transactional inbox → effectively-once processing). */
export const inboxMessages = pgTable('inbox_messages', {
  messageId: text('message_id').primaryKey(),
  topic: text('topic').notNull(),
  partition: integer('partition').notNull(),
  offset: text('offset').notNull(),
  messageType: text('message_type').notNull(),
  processedAt: timestamptz('processed_at').notNull().defaultNow(),
});

/** Events written atomically with state changes, published to Kafka by the outbox relay. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: uuid('event_id').notNull().defaultRandom().unique(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    publishedAt: timestamptz('published_at'),
  },
  (t) => [
    index('outbox_events_unpublished_idx')
      .on(t.id)
      .where(sql`${t.publishedAt} is null`),
  ],
);
