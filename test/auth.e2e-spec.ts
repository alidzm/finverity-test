import { createProgram } from './support/fixtures';
import { createTestApp, type TestApp } from './support/test-app';

describe('Authentication & authorization', () => {
  let t: TestApp;
  let programId: string;

  beforeAll(async () => {
    t = await createTestApp();
    programId = await createProgram(t.app);
  });
  afterAll(() => t.close());

  const capacity = () => t.http.get(`/v1/programs/${programId}/capacity`);

  it('accepts a valid token with the required scope', async () => {
    await capacity()
      .set('Authorization', `Bearer ${await t.token({ scope: 'capacity:read' })}`)
      .expect(200);
  });

  it.each([
    ['no Authorization header', undefined],
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a malformed token', 'Bearer not.a.jwt'],
  ])('rejects requests with %s', async (_, header) => {
    const request = capacity();
    const response = await (header ? request.set('Authorization', header) : request).expect(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(response.headers['www-authenticate']).toContain('Bearer');
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it.each([
    ['expired', { expiresIn: '-1m' }],
    ['issued for another audience', { audience: 'another-service' }],
    ['issued by another issuer', { issuer: 'https://evil.test' }],
  ])('rejects a token that is %s', async (_, options) => {
    const token = await t.token(options);
    const response = await capacity().set('Authorization', `Bearer ${token}`).expect(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await createTestApp();
    try {
      const foreign = await other.token();
      await capacity().set('Authorization', `Bearer ${foreign}`).expect(401);
    } finally {
      await other.close();
    }
  });

  it('enforces scopes per operation', async () => {
    const readOnly = `Bearer ${await t.token({ scope: 'capacity:read' })}`;
    const response = await t.http
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', readOnly)
      .send({ invoiceId: 'INV-1', amount: { value: '1.00', currency: 'USD' } })
      .expect(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      requiredScopes: ['capacity:reserve'],
    });

    const reserveOnly = `Bearer ${await t.token({ scope: 'capacity:reserve' })}`;
    await capacity().set('Authorization', reserveOnly).expect(403);
  });

  it('keeps only the health probes public', async () => {
    await t.http.get('/health/live').expect(200);
    await t.http.get('/health/ready').expect(200);
    await t.http.get('/v1/programs').expect(401);
  });

  it('serves the test console without a token only when enabled; its API calls still need one', async () => {
    await t.http.get('/ui/').expect(404);

    const withUi = await createTestApp({ DEV_UI_ENABLED: 'true' });
    try {
      const page = await withUi.http.get('/ui/').expect(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.text).toContain('Capacity test console');
      await withUi.http.get('/v1/programs').expect(401);
    } finally {
      await withUi.close();
    }
  });

  it('echoes a caller-supplied request id', async () => {
    const response = await capacity()
      .set('Authorization', t.auth)
      .set('x-request-id', 'req-123')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('req-123');
  });
});
