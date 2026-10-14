import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReserveCapacityUseCase } from '@/capacity/application/use-cases/reserve-capacity.use-case';
import { createProgram } from './support/fixtures';
import { eventually } from './support/kafka';
import { createTestApp, type TestApp } from './support/test-app';

interface SseEvent {
  event: string;
  id?: string;
  data: Record<string, unknown>;
}

describe('Live capacity stream (SSE)', () => {
  let t: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    t = await createTestApp({ SSE_HEARTBEAT_INTERVAL_MS: '500' });
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(() => t.close());

  function openStream(programId: string, authorization?: string) {
    const events: SseEvent[] = [];
    let buffer = '';
    let close = () => {};
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(
        `${baseUrl}/v1/programs/${programId}/capacity/stream`,
        { headers: authorization ? { Authorization: authorization } : {} },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const fields = Object.fromEntries(
                block
                  .split('\n')
                  .filter((line) => line.includes(':'))
                  .map((line) => [
                    line.slice(0, line.indexOf(':')),
                    line.slice(line.indexOf(':') + 1).trim(),
                  ]),
              );
              if (fields.data) {
                events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data) });
              }
            }
          });
          resolve(res);
        },
      );
      request.on('error', reject);
      close = () => request.destroy();
    });
    return { events, response, close: () => close() };
  }

  it('streams the current capacity, then every committed change', async () => {
    const programId = await createProgram(t.app, { creditLimit: '1000.00' });
    const stream = openStream(programId, t.auth);
    try {
      const response = await stream.response;
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      await eventually(() =>
        expect(stream.events.find((e) => e.event === 'capacity')?.data).toMatchObject({
          version: 1,
          available: '1000.00',
        }),
      );
      await t.app
        .get(ReserveCapacityUseCase)
        .execute(
          { programId, invoiceId: 'INV-1', amount: { value: '400.00', currency: 'USD' } },
          { source: 'API', actor: 'test', correlationId: null },
        );

      await eventually(() => {
        const capacity = stream.events.filter((e) => e.event === 'capacity');
        expect(capacity.map((e) => e.id)).toEqual(['1', '2']);
        expect(capacity[1].data).toMatchObject({ reserved: '400.00', available: '600.00' });
      });
      await eventually(() => expect(stream.events.some((e) => e.event === 'heartbeat')).toBe(true));
    } finally {
      stream.close();
    }
  });

  it('answers with a problem document before streaming for unknown programs or missing auth', async () => {
    const unknown = openStream('PRG-NOPE', t.auth);
    expect((await unknown.response).statusCode).toBe(404);
    unknown.close();

    const anonymous = openStream('PRG-NOPE');
    expect((await anonymous.response).statusCode).toBe(401);
    anonymous.close();
  });
});
