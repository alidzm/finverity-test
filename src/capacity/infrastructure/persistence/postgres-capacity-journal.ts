import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { toCapacityDto } from '@/capacity/application/dto/capacity.dto';
import {
  type CapacityChange,
  CapacityJournal,
} from '@/capacity/application/ports/capacity-journal';
import { DrizzleTransactionManager } from '@/shared/infrastructure/database/drizzle-transaction-manager';
import { OutboxWriter } from '@/shared/infrastructure/messaging/outbox.writer';
import { capacityLedger } from './capacity.schema';

/** PostgreSQL channel carrying committed capacity changes (see PostgresCapacityChangeFeed). */
export const CAPACITY_CHANGED_CHANNEL = 'capacity_changed';

const LEDGER_CHUNK_SIZE = 1_000;

/**
 * Records ledger entries, the outbound event (outbox) and a NOTIFY in the current
 * transaction. PostgreSQL delivers the notification only if — and when — the transaction
 * commits, so live subscribers never see uncommitted or rolled-back state.
 */
@Injectable()
export class PostgresCapacityJournal extends CapacityJournal {
  constructor(
    private readonly drizzle: DrizzleTransactionManager,
    private readonly outbox: OutboxWriter,
  ) {
    super();
  }

  async record(change: CapacityChange): Promise<void> {
    const tx = this.drizzle.transaction;
    const { program, context } = change;
    const entries = change.ledger.map((entry) => ({
      programId: program.id,
      entryType: entry.entryType,
      reservationId: entry.reservationId ?? null,
      deltaReservedMinor: entry.deltaReservedMinor ?? 0n,
      deltaCreditLimitMinor: entry.deltaCreditLimitMinor ?? 0n,
      reservedAfterMinor: entry.reservedAfterMinor ?? program.reservedMinor,
      creditLimitAfterMinor: entry.creditLimitAfterMinor ?? program.creditLimitMinor,
      source: context.source,
      actor: context.actor,
      correlationId: context.correlationId,
    }));
    for (let i = 0; i < entries.length; i += LEDGER_CHUNK_SIZE) {
      await tx.insert(capacityLedger).values(entries.slice(i, i + LEDGER_CHUNK_SIZE));
    }

    const capacity = toCapacityDto(program);
    if (change.event) {
      await this.outbox.enqueue({
        aggregateId: program.id,
        type: change.event.type,
        payload: { ...change.event.payload, capacity, source: context.source },
      });
    }
    await tx.execute(
      sql`select pg_notify(${CAPACITY_CHANGED_CHANNEL}, ${JSON.stringify(capacity)})`,
    );
  }
}
