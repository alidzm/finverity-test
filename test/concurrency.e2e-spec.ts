import { sql } from 'drizzle-orm';
import { ReleaseCapacityUseCase } from '@/capacity/application/use-cases/release-capacity.use-case';
import { ReserveCapacityUseCase } from '@/capacity/application/use-cases/reserve-capacity.use-case';
import type { OperationContext } from '@/capacity/application/operation-context';
import { DomainError } from '@/shared/domain/domain-error';
import { DatabaseService } from '@/shared/infrastructure/database/database.service';
import { assertInvariants, createProgram } from './support/fixtures';
import { createTestApp, type TestApp } from './support/test-app';

const api: OperationContext = { source: 'API', actor: 'load-test', correlationId: null };

describe('Concurrency', () => {
  let t: TestApp;
  let reserveCapacity: ReserveCapacityUseCase;
  let releaseCapacity: ReleaseCapacityUseCase;

  beforeAll(async () => {
    t = await createTestApp({ DATABASE_POOL_MAX: '30' });
    reserveCapacity = t.app.get(ReserveCapacityUseCase);
    releaseCapacity = t.app.get(ReleaseCapacityUseCase);
  });
  afterAll(() => t.close());

  const reserve = (programId: string, invoiceId: string, value: string) =>
    reserveCapacity.execute({ programId, invoiceId, amount: { value, currency: 'USD' } }, api);

  const codeOf = (result: PromiseSettledResult<unknown>) =>
    result.status === 'rejected' ? (result.reason as DomainError).code : 'OK';

  it('never oversubscribes a program under concurrent reservations', async () => {
    // 1,000,000.00 limit, 250 parallel requests of 10,000.00 → exactly 100 can succeed.
    const programId = await createProgram(t.app, { creditLimit: '1000000.00' });

    const results = await Promise.allSettled(
      Array.from({ length: 250 }, (_, i) => reserve(programId, `INV-${i}`, '10000.00')),
    );

    const outcomes = results.map(codeOf);
    expect(outcomes.filter((code) => code === 'OK')).toHaveLength(100);
    expect(outcomes.filter((code) => code === 'INSUFFICIENT_CAPACITY')).toHaveLength(150);
    expect(await assertInvariants(t.app, programId)).toBe(100_000_000n);
  });

  it('creates exactly one reservation for concurrent duplicate requests', async () => {
    const programId = await createProgram(t.app);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserve(programId, 'INV-DUP', '123.45')),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.reservation.id)).size).toBe(1);
    expect(await assertInvariants(t.app, programId)).toBe(12_345n);
  });

  it('answers duplicates racing for the last capacity as replays, not rejections', async () => {
    // Exactly one invoice fits. Open the connections first so that the requests really race.
    const programId = await createProgram(t.app, { creditLimit: '100.00' });
    const db = t.app.get(DatabaseService).db;
    await Promise.all(Array.from({ length: 10 }, () => db.execute(sql`select pg_sleep(0.02)`)));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(programId, 'INV-LAST', '100.00')),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.reservation.id)).size).toBe(1);
    expect(await assertInvariants(t.app, programId)).toBe(10_000n);
  });

  it('applies a release once when the same releaseId arrives concurrently', async () => {
    const programId = await createProgram(t.app);
    await reserve(programId, 'INV-1', '1000.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        releaseCapacity.execute(
          {
            programId,
            invoiceId: 'INV-1',
            releaseId: 'RPM-1',
            amount: { value: '250.00', currency: 'USD' },
          },
          api,
        ),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await assertInvariants(t.app, programId)).toBe(75_000n);
  });

  it('keeps the books consistent under a mixed reserve/release load', async () => {
    const programId = await createProgram(t.app, { creditLimit: '50000.00' });
    for (let i = 0; i < 20; i++) {
      await reserve(programId, `SEED-${i}`, '1000.00');
    }

    const operations = Array.from({ length: 120 }, (_, i) =>
      i % 2 === 0
        ? reserve(programId, `NEW-${i}`, '700.00')
        : releaseCapacity.execute(
            {
              programId,
              invoiceId: `SEED-${((i - 1) / 2) % 20}`,
              releaseId: `RPM-${i}`,
              amount: { value: '50.00', currency: 'USD' },
            },
            api,
          ),
    );
    const results = await Promise.allSettled(operations);

    const unexpected = results
      .map(codeOf)
      .filter(
        (code) => !['OK', 'INSUFFICIENT_CAPACITY', 'RELEASE_EXCEEDS_OUTSTANDING'].includes(code),
      );
    expect(unexpected).toEqual([]);
    const reserved = await assertInvariants(t.app, programId);
    expect(reserved).toBeLessThanOrEqual(5_000_000n);
  });
});
