import { assertInvariants, createProgram, setFxRate } from './support/fixtures';
import { createTestApp, type TestApp, uniqueId } from './support/test-app';

describe('Reservations API', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await setFxRate(t.app, 'EUR', 'USD', '1.08345');
    await setFxRate(t.app, 'USD', 'JPY', '149.5');
  });
  afterAll(() => t.close());

  const reserve = (programId: string, invoiceId: string, value: string, currency = 'USD') =>
    t.http
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', t.auth)
      .send({ invoiceId, amount: { value, currency } });

  const release = (programId: string, invoiceId: string, body: object) =>
    t.http
      .post(`/v1/programs/${programId}/reservations/${invoiceId}/releases`)
      .set('Authorization', t.auth)
      .send(body);

  const capacity = async (programId: string) =>
    (
      await t.http
        .get(`/v1/programs/${programId}/capacity`)
        .set('Authorization', t.auth)
        .expect(200)
    ).body;

  it('reserves capacity in the program currency and exposes the new availability', async () => {
    const programId = await createProgram(t.app, { creditLimit: '10000000.00' });

    const response = await reserve(programId, 'INV-1', '2500000.00').expect(201);

    expect(response.headers.location).toBe(`/v1/programs/${programId}/reservations/INV-1`);
    expect(response.body).toMatchObject({
      invoiceId: 'INV-1',
      status: 'ACTIVE',
      reservedAmount: { value: '2500000.00', currency: 'USD' },
      outstandingAmount: { value: '2500000.00', currency: 'USD' },
      fxRate: '1',
    });
    expect(await capacity(programId)).toMatchObject({
      creditLimit: '10000000.00',
      reserved: '2500000.00',
      available: '7500000.00',
      version: 2,
    });
    await assertInvariants(t.app, programId);
  });

  it('converts foreign-currency invoices at the treasury rate, rounding up', async () => {
    const programId = await createProgram(t.app);

    const eur = await reserve(programId, 'INV-EUR', '1000.01', 'EUR').expect(201);
    // 1,000.01 × 1.08345 = 1,083.4608345 → 1,083.47 (ceil)
    expect(eur.body.reservedAmount).toEqual({ value: '1083.47', currency: 'USD' });
    expect(eur.body.fxRate).toBe('1.08345');

    // Inverse pair: JPY → USD using 1/149.5; 10,000 JPY = 66.889… → 66.89
    const jpy = await reserve(programId, 'INV-JPY', '10000', 'JPY').expect(201);
    expect(jpy.body.reservedAmount).toEqual({ value: '66.89', currency: 'USD' });
    await assertInvariants(t.app, programId);
  });

  it('is idempotent per invoice and rejects conflicting replays', async () => {
    const programId = await createProgram(t.app);
    const first = await reserve(programId, 'INV-1', '100.00').expect(201);

    const replay = await reserve(programId, 'INV-1', '100.00').expect(200);
    expect(replay.body.id).toBe(first.body.id);

    const conflict = await reserve(programId, 'INV-1', '100.01').expect(409);
    expect(conflict.body).toMatchObject({
      code: 'RESERVATION_CONFLICT',
      existingAmount: { value: '100.00' },
    });
    expect((await capacity(programId)).reserved).toBe('100.00');
  });

  it('rejects reservations exceeding the available capacity', async () => {
    const programId = await createProgram(t.app, { creditLimit: '1000.00' });
    await reserve(programId, 'INV-1', '600.00').expect(201);

    const rejected = await reserve(programId, 'INV-2', '400.01').expect(422);

    expect(rejected.headers['content-type']).toContain('application/problem+json');
    expect(rejected.body).toMatchObject({
      code: 'INSUFFICIENT_CAPACITY',
      status: 422,
      requested: '400.01',
      available: '400.00',
    });
    await reserve(programId, 'INV-3', '400.00').expect(201);
    expect((await capacity(programId)).available).toBe('0.00');
  });

  it('rejects reservations on suspended or unknown programs', async () => {
    const suspended = await createProgram(t.app, { status: 'SUSPENDED' });
    expect((await reserve(suspended, 'INV-1', '1.00').expect(422)).body.code).toBe(
      'PROGRAM_SUSPENDED',
    );
    expect((await reserve('PRG-UNKNOWN', 'INV-1', '1.00').expect(404)).body.code).toBe(
      'PROGRAM_NOT_FOUND',
    );
  });

  it('fails closed when an FX rate is missing or stale', async () => {
    const programId = await createProgram(t.app);
    expect((await reserve(programId, 'INV-1', '1.00', 'CHF').expect(422)).body.code).toBe(
      'FX_RATE_NOT_FOUND',
    );

    await setFxRate(t.app, 'GBP', 'USD', '1.27', new Date(Date.now() - 2 * 86_400_000));
    expect((await reserve(programId, 'INV-2', '1.00', 'GBP').expect(503)).body.code).toBe(
      'FX_RATE_STALE',
    );
  });

  it('validates request bodies', async () => {
    const programId = await createProgram(t.app);
    const tooPrecise = await reserve(programId, 'INV-1', '1.001').expect(400);
    expect(tooPrecise.body.code).toBe('INVALID_AMOUNT');

    const unknownCurrency = await reserve(programId, 'INV-1', '1.00', 'XYZ').expect(422);
    expect(unknownCurrency.body.code).toBe('UNSUPPORTED_CURRENCY');

    const malformed = await t.http
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', t.auth)
      .send({ invoiceId: '', amount: { value: '-1', currency: 'usd' }, unexpected: true })
      .expect(400);
    expect(malformed.body.code).toBe('VALIDATION_FAILED');
    expect(malformed.body.errors.length).toBeGreaterThanOrEqual(3);
  });

  describe('releases', () => {
    it('releases partially at the locked rate and fully without leaving dust', async () => {
      const programId = await createProgram(t.app);
      await reserve(programId, 'INV-1', '1000.00', 'EUR').expect(201); // → 1,083.45 USD
      // The rate moves; releases must ignore it.
      await setFxRate(t.app, 'EUR', 'USD', '1.20000');

      const partial = await release(programId, 'INV-1', {
        releaseId: 'RPM-1',
        amount: { value: '333.33', currency: 'EUR' },
      }).expect(201);
      expect(partial.body.release.releasedAmount).toEqual({ value: '361.14', currency: 'USD' });
      expect(partial.body.reservation).toMatchObject({
        status: 'ACTIVE',
        outstandingAmount: { value: '722.31' },
      });

      const full = await release(programId, 'INV-1', { releaseId: 'RPM-2' }).expect(201);
      expect(full.body.release.releasedInvoiceAmount).toEqual({ value: '666.67', currency: 'EUR' });
      expect(full.body.release.releasedAmount).toEqual({ value: '722.31', currency: 'USD' });
      expect(full.body.reservation.status).toBe('RELEASED');
      expect((await capacity(programId)).reserved).toBe('0.00');
      await assertInvariants(t.app, programId);

      const details = await t.http
        .get(`/v1/programs/${programId}/reservations/INV-1`)
        .set('Authorization', t.auth)
        .expect(200);
      expect(details.body.releases.map((r: { releaseId: string }) => r.releaseId)).toEqual([
        'RPM-1',
        'RPM-2',
      ]);
      await setFxRate(t.app, 'EUR', 'USD', '1.08345');
    });

    it('is idempotent per releaseId and validates release requests', async () => {
      const programId = await createProgram(t.app);
      await reserve(programId, 'INV-1', '100.00').expect(201);
      await reserve(programId, 'INV-2', '100.00').expect(201);
      const body = { releaseId: 'RPM-1', amount: { value: '40.00', currency: 'USD' } };

      await release(programId, 'INV-1', body).expect(201);
      const replay = await release(programId, 'INV-1', body).expect(200);
      expect(replay.body.reservation.releasedAmount.value).toBe('40.00');

      const reused = await release(programId, 'INV-2', body).expect(409);
      expect(reused.body.code).toBe('RELEASE_CONFLICT');
      const exceeds = await release(programId, 'INV-1', {
        releaseId: 'RPM-2',
        amount: { value: '60.01', currency: 'USD' },
      }).expect(422);
      expect(exceeds.body.code).toBe('RELEASE_EXCEEDS_OUTSTANDING');
      const mismatch = await release(programId, 'INV-1', {
        releaseId: 'RPM-3',
        amount: { value: '1.00', currency: 'EUR' },
      }).expect(422);
      expect(mismatch.body.code).toBe('CURRENCY_MISMATCH');

      await release(programId, 'INV-1', { releaseId: 'RPM-4' }).expect(201);
      const again = await release(programId, 'INV-1', { releaseId: 'RPM-5' }).expect(422);
      expect(again.body.code).toBe('RESERVATION_ALREADY_RELEASED');
      const missing = await release(programId, 'INV-404', { releaseId: 'RPM-6' }).expect(404);
      expect(missing.body.code).toBe('RESERVATION_NOT_FOUND');
      expect((await capacity(programId)).reserved).toBe('100.00');
      await assertInvariants(t.app, programId);
    });
  });

  describe('queries', () => {
    it('paginates reservations with an opaque cursor and filters by status', async () => {
      const programId = await createProgram(t.app);
      for (let i = 1; i <= 5; i++) {
        await reserve(programId, `INV-${i}`, '10.00').expect(201);
      }
      await release(programId, 'INV-2', { releaseId: uniqueId('RPM') }).expect(201);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { items: { invoiceId: string }[]; nextCursor: string | null } } =
          await t.http
            .get(`/v1/programs/${programId}/reservations`)
            .query({ limit: 2, ...(cursor ? { cursor } : {}) })
            .set('Authorization', t.auth)
            .expect(200);
        seen.push(...page.body.items.map((item) => item.invoiceId));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']);

      const active = await t.http
        .get(`/v1/programs/${programId}/reservations?status=ACTIVE`)
        .set('Authorization', t.auth)
        .expect(200);
      expect(active.body.items).toHaveLength(4);

      const badCursor = await t.http
        .get(`/v1/programs/${programId}/reservations?cursor=not-a-cursor`)
        .set('Authorization', t.auth)
        .expect(400);
      expect(badCursor.body.code).toBe('VALIDATION_FAILED');
    });

    it('returns 404 problems for unknown programs and reservations', async () => {
      const programId = await createProgram(t.app);
      const noProgram = await t.http
        .get('/v1/programs/PRG-NOPE/capacity')
        .set('Authorization', t.auth)
        .expect(404);
      expect(noProgram.body.code).toBe('PROGRAM_NOT_FOUND');
      const noReservation = await t.http
        .get(`/v1/programs/${programId}/reservations/INV-NOPE`)
        .set('Authorization', t.auth)
        .expect(404);
      expect(noReservation.body.code).toBe('RESERVATION_NOT_FOUND');
    });
  });
});
