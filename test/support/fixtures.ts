import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { treasuryContext } from '@/capacity/application/operation-context';
import { UpsertProgramUseCase } from '@/capacity/application/use-cases/upsert-program.use-case';
import {
  capacityLedger,
  programs,
  reservations,
} from '@/capacity/infrastructure/persistence/capacity.schema';
import { FxRateService } from '@/fx/application/fx-rate.service';
import type { InboxRef } from '@/shared/application/messaging/message-inbox';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { DatabaseService } from '@/shared/infrastructure/database/database.service';
import { uniqueId } from './test-app';

let sequence = 0;
export const nextSequence = () => Date.now() * 1000 + (sequence++ % 1000);

/** A fresh inbox reference, as the treasury consumer would build it for a new message. */
export function inboxRef(messageType = 'Test'): InboxRef {
  return { messageId: randomUUID(), topic: 'test', partition: 0, offset: '0', messageType };
}

export const treasury = () => treasuryContext(randomUUID());

/** Creates a program through the same use case the treasury consumer uses. */
export async function createProgram(
  app: INestApplication,
  options: { currency?: CurrencyCode; creditLimit?: string; status?: 'ACTIVE' | 'SUSPENDED' } = {},
): Promise<string> {
  const programId = uniqueId('PRG');
  await app.get(UpsertProgramUseCase).execute(
    {
      programId,
      sequence: nextSequence(),
      currency: options.currency ?? 'USD',
      creditLimit: options.creditLimit ?? '1000000.00',
      status: options.status ?? 'ACTIVE',
    },
    treasury(),
  );
  return programId;
}

export async function setFxRate(
  app: INestApplication,
  base: CurrencyCode,
  quote: CurrencyCode,
  rate: string,
  asOf = new Date(),
): Promise<void> {
  // Force-overwrite (tests may move asOf backwards to simulate staleness).
  await app
    .get(DatabaseService)
    .db.execute(
      sql`delete from fx_rates where base_currency = ${base} and quote_currency = ${quote}`,
    );
  await app.get(FxRateService).record({ base, quote, rate, asOf });
}

/** Asserts the core invariants of a program; returns its reserved amount. */
export async function assertInvariants(app: INestApplication, programId: string): Promise<bigint> {
  const db = app.get(DatabaseService).db;
  const [program] = await db.select().from(programs).where(eq(programs.id, programId));
  const [{ outstanding }] = await db
    .select({ outstanding: sql<string>`coalesce(sum(reserved_minor - released_minor), 0)` })
    .from(reservations)
    .where(sql`${reservations.programId} = ${programId} and ${reservations.status} = 'ACTIVE'`);
  const [{ journaled }] = await db
    .select({ journaled: sql<string>`coalesce(sum(delta_reserved_minor), 0)` })
    .from(capacityLedger)
    .where(eq(capacityLedger.programId, programId));

  expect(BigInt(outstanding)).toBe(program.reservedMinor);
  expect(BigInt(journaled)).toBe(program.reservedMinor);
  expect(program.reservedMinor).toBeGreaterThanOrEqual(0n);
  return program.reservedMinor;
}
