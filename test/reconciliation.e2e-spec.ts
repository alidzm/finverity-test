import { eq } from 'drizzle-orm';
import type { OperationContext } from '@/capacity/application/operation-context';
import {
  type ReconcileProgramCommand,
  ReconcileProgramUseCase,
  type SnapshotReservationInput,
} from '@/capacity/application/use-cases/reconcile-program.use-case';
import { ReleaseCapacityUseCase } from '@/capacity/application/use-cases/release-capacity.use-case';
import { ReserveCapacityUseCase } from '@/capacity/application/use-cases/reserve-capacity.use-case';
import { programs, reservations } from '@/capacity/infrastructure/persistence/capacity.schema';
import { MessageDeduplicator } from '@/shared/application/messaging/message-deduplicator';
import { DatabaseService } from '@/shared/infrastructure/database/database.service';
import {
  assertInvariants,
  createProgram,
  inboxRef,
  nextSequence,
  treasury,
} from './support/fixtures';
import { createTestApp, type TestApp, uniqueId } from './support/test-app';

const api: OperationContext = { source: 'API', actor: 'test', correlationId: null };
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

function item(invoiceId: string, reserved: string, released = '0.00'): SnapshotReservationInput {
  return {
    invoiceId,
    invoiceAmount: { value: reserved, currency: 'USD' },
    reservedAmount: reserved,
    releasedAmount: released,
    releasedInvoiceAmount: released,
  };
}

describe('Reconciliation', () => {
  let t: TestApp;
  let reconcile: ReconcileProgramUseCase;

  beforeAll(async () => {
    t = await createTestApp({ RECONCILIATION_GRACE_SECONDS: '300' });
    reconcile = t.app.get(ReconcileProgramUseCase);
  });
  afterAll(() => t.close());

  const snapshot = (
    programId: string,
    overrides: Partial<ReconcileProgramCommand> = {},
  ): ReconcileProgramCommand => ({
    programId,
    sequence: nextSequence(),
    asOf: new Date(),
    currency: 'USD',
    creditLimit: '1000000.00',
    status: 'ACTIVE',
    reservations: [],
    ...overrides,
  });
  const reserve = (programId: string, invoiceId: string, value: string) =>
    t.app
      .get(ReserveCapacityUseCase)
      .execute({ programId, invoiceId, amount: { value, currency: 'USD' } }, api);
  const reservation = async (programId: string, invoiceId: string) => {
    const db = t.app.get(DatabaseService).db;
    const rows = await db.select().from(reservations).where(eq(reservations.programId, programId));
    return rows.find((row) => row.invoiceId === invoiceId)!;
  };
  const program = async (programId: string) => {
    const [row] = await t.app
      .get(DatabaseService)
      .db.select()
      .from(programs)
      .where(eq(programs.id, programId));
    return row;
  };

  it('bootstraps an unknown program from a snapshot', async () => {
    const programId = uniqueId('PRG');
    const result = await reconcile.execute(
      snapshot(programId, {
        creditLimit: '500000.00',
        reservations: [item('T-1', '1000.00'), item('T-2', '50.00', '50.00')],
      }),
      treasury(),
    );

    expect(result).toMatchObject({ outcome: 'APPLIED', written: 1 });
    expect(await program(programId)).toMatchObject({
      creditLimitMinor: 50_000_000n,
      reservedMinor: 100_000n,
    });
    expect((await reservation(programId, 'T-1')).source).toBe('TREASURY');
    await assertInvariants(t.app, programId);
  });

  it('adopts treasury state: new limit, repayments and unknown reservations', async () => {
    const programId = await createProgram(t.app);
    await reserve(programId, 'INV-1', '1000.00');
    await reserve(programId, 'INV-2', '2000.00');

    await reconcile.execute(
      snapshot(programId, {
        asOf: minutes(10), // beyond the grace window of the API changes above
        creditLimit: '750000.00',
        reservations: [
          item('INV-1', '1000.00', '1000.00'),
          item('INV-2', '2000.00', '500.00'),
          item('T-9', '300.00'),
        ],
      }),
      treasury(),
    );

    expect((await reservation(programId, 'INV-1')).status).toBe('RELEASED');
    expect((await reservation(programId, 'INV-2')).releasedMinor).toBe(50_000n);
    expect(await program(programId)).toMatchObject({
      creditLimitMinor: 75_000_000n,
      reservedMinor: 180_000n,
    });
    await assertInvariants(t.app, programId);
  });

  it('keeps changes made through the API after the snapshot was taken', async () => {
    const programId = await createProgram(t.app);
    await reserve(programId, 'INV-1', '1000.00');
    const asOf = minutes(-1); // snapshot taken before the release below
    await t.app
      .get(ReleaseCapacityUseCase)
      .execute({ programId, invoiceId: 'INV-1', releaseId: 'RPM-1' }, api);

    const result = await reconcile.execute(
      snapshot(programId, { asOf, reservations: [item('INV-1', '1000.00')] }),
      treasury(),
    );

    expect(result.keptNewerLocal).toBe(1);
    expect((await reservation(programId, 'INV-1')).status).toBe('RELEASED');
    expect(await assertInvariants(t.app, programId)).toBe(0n);
  });

  it('keeps in-flight reservations and flags — without releasing — the ones treasury lost', async () => {
    const programId = await createProgram(t.app);
    await reserve(programId, 'INV-LOST', '400.00');

    // asOf = now: INV-LOST is younger than the grace window → in flight.
    const first = await reconcile.execute(snapshot(programId), treasury());
    expect(first).toMatchObject({ keptInFlight: 1, discrepancies: [] });

    // asOf well after creation (+ grace): treasury should know it but does not.
    const second = await reconcile.execute(snapshot(programId, { asOf: minutes(10) }), treasury());
    expect(second.discrepancies).toEqual(['INV-LOST']);
    expect(await reservation(programId, 'INV-LOST')).toMatchObject({
      status: 'ACTIVE',
      discrepancy: true,
    });
    expect(await assertInvariants(t.app, programId)).toBe(40_000n);

    // Treasury catches up: the flag is cleared.
    await reconcile.execute(
      snapshot(programId, { asOf: minutes(11), reservations: [item('INV-LOST', '400.00')] }),
      treasury(),
    );
    expect((await reservation(programId, 'INV-LOST')).discrepancy).toBe(false);
  });

  it('ignores duplicate and out-of-order snapshots', async () => {
    const programId = await createProgram(t.app);
    const deduplicator = t.app.get(MessageDeduplicator);
    const ref = inboxRef('ProgramReconciled');
    const latest = snapshot(programId, { creditLimit: '200.00' });
    const deliver = () =>
      deduplicator.processOnce(ref, () => reconcile.execute(latest, treasury()));

    expect(await deliver()).toMatchObject({ outcome: 'APPLIED' });
    expect(await deliver()).toBe('DUPLICATE');
    const older = snapshot(programId, { sequence: latest.sequence - 1, creditLimit: '999.00' });
    expect((await reconcile.execute(older, treasury())).outcome).toBe('STALE');
    expect((await program(programId)).creditLimitMinor).toBe(20_000n);
  });

  it('rejects snapshots that would change the program currency or are inconsistent', async () => {
    const programId = await createProgram(t.app);
    await expect(
      reconcile.execute(snapshot(programId, { currency: 'EUR' }), treasury()),
    ).rejects.toMatchObject({ code: 'PROGRAM_CURRENCY_IMMUTABLE' });
    await expect(
      reconcile.execute(
        snapshot(programId, { reservations: [item('X', '10.00', '20.00')] }),
        treasury(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TREASURY_MESSAGE' });
  });

  it('lets an over-limit program keep its reservations but rejects new ones', async () => {
    const programId = await createProgram(t.app, { creditLimit: '1000.00' });
    await reserve(programId, 'INV-1', '800.00');

    await reconcile.execute(
      snapshot(programId, { creditLimit: '500.00', reservations: [item('INV-1', '800.00')] }),
      treasury(),
    );

    const capacity = await t.http
      .get(`/v1/programs/${programId}/capacity`)
      .set('Authorization', t.auth)
      .expect(200);
    expect(capacity.body).toMatchObject({
      creditLimit: '500.00',
      reserved: '800.00',
      available: '-300.00',
    });
    await expect(reserve(programId, 'INV-2', '0.01')).rejects.toMatchObject({
      code: 'INSUFFICIENT_CAPACITY',
    });
  });
});
