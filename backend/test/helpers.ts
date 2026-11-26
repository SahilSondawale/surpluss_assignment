import { DataSource } from 'typeorm';
import { migrations } from '../src/database/migrations/index.js';
import { EventsRepository } from '../src/worker/events.repository.js';
import { EventProcessor } from '../src/worker/event-processor.js';
import type { WorkerConfig } from '../src/worker/worker.config.js';
import { WebhooksService } from '../src/webhooks/webhooks.service.js';

/** Tests use their own database so they never touch real data. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://webhook:webhook@localhost:5432/webhooks_test';

export async function connectTestDatabase(): Promise<DataSource> {
  const dataSource = new DataSource({ type: 'postgres', url: TEST_DATABASE_URL, migrations });
  await dataSource.initialize();
  return dataSource;
}

export async function clearTables(db: DataSource): Promise<void> {
  await db.query('TRUNCATE event_attempts, processed_orders, events');
}

/** Small, fast settings for tests: no waiting between retries. */
export function testWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    workerId: 'test-worker',
    concurrency: 1,
    leaseSeconds: 30,
    heartbeatSeconds: 10,
    pollIntervalMs: 10,
    maxAttempts: 3,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    ...overrides,
  };
}

export function createProcessor(db: DataSource, overrides: Partial<WorkerConfig> = {}) {
  return new EventProcessor(new EventsRepository(db), testWorkerConfig(overrides));
}

/** Keeps processing until there is nothing left to do. */
export async function processUntilIdle(processor: EventProcessor): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const didWork = await processor.processNext();
    if (!didWork) return;
  }
  throw new Error('processUntilIdle: still busy after 1000 rounds');
}

export async function sendEvent(db: DataSource, eventId: string, simulate?: string) {
  return new WebhooksService(db).ingest({
    eventId,
    type: 'order.created',
    data: { orderId: `ORD-${eventId}`, ...(simulate ? { simulate } : {}) },
  });
}

/** Pretend the lease ran out (as if the worker died and time passed). */
export async function expireLease(db: DataSource, eventId: string): Promise<void> {
  await db.query(
    `UPDATE events SET locked_until = now() - interval '1 second' WHERE event_id = $1`,
    [eventId],
  );
}

export async function getEvent(db: DataSource, eventId: string) {
  const rows = await db.query(
    `SELECT status, attempt_count, attempts_since_reset, last_error FROM events WHERE event_id = $1`,
    [eventId],
  );
  return rows[0];
}

export async function getAttempts(db: DataSource, eventId: string) {
  return db.query<{ attempt_number: number; worker_id: string; result: string | null }[]>(
    `SELECT attempt_number, worker_id, result FROM event_attempts
     WHERE event_id = $1 ORDER BY attempt_number`,
    [eventId],
  );
}

export async function countProcessedOrders(db: DataSource, eventId?: string): Promise<number> {
  const rows = eventId
    ? await db.query(`SELECT count(*)::int AS n FROM processed_orders WHERE event_id = $1`, [eventId])
    : await db.query(`SELECT count(*)::int AS n FROM processed_orders`);
  return rows[0].n;
}
