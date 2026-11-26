import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import {
  TEST_DATABASE_URL,
  clearTables,
  connectTestDatabase,
  countProcessedOrders,
  createProcessor,
  processUntilIdle,
} from './helpers.js';

describe('POST /webhooks (integration, real Postgres)', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL; // the API uses the test database
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  beforeEach(async () => {
    await clearTables(db);
  });

  const body = {
    eventId: 'evt_dup',
    type: 'order.created',
    data: { orderId: 'ORD-1001', customerId: 'CUS-42' },
  };

  it('10 simultaneous copies of one event → 1 event, and after processing 1 processed_orders row', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app.getHttpServer()).post('/webhooks').send(body)),
    );

    // Every delivery is acknowledged; exactly one of them was new.
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(responses.filter((r) => r.body.duplicate === false)).toHaveLength(1);

    const events = await db.query(`SELECT count(*)::int AS n FROM events`);
    expect(events[0].n).toBe(1);

    // Three workers race to process it.
    const workers = [1, 2, 3].map((n) => createProcessor(db, { workerId: `worker-${n}` }));
    await Promise.all(workers.map((w) => processUntilIdle(w)));

    expect(await countProcessedOrders(db, 'evt_dup')).toBe(1);
  });

  it('keeps the first payload when the same eventId arrives with a different payload', async () => {
    await request(app.getHttpServer()).post('/webhooks').send(body).expect(202);
    await request(app.getHttpServer())
      .post('/webhooks')
      .send({ ...body, data: { orderId: 'CHANGED' } })
      .expect(202);

    const rows = await db.query(`SELECT payload->'data'->>'orderId' AS "orderId" FROM events`);
    expect(rows).toEqual([{ orderId: 'ORD-1001' }]);
  });

  it('rejects an invalid body with 400 and stores nothing', async () => {
    await request(app.getHttpServer())
      .post('/webhooks')
      .send({ eventId: 'evt_x', type: 'order.created', data: { simulate: 'explode' } })
      .expect(400);

    const events = await db.query(`SELECT count(*)::int AS n FROM events`);
    expect(events[0].n).toBe(0);
  });
});
