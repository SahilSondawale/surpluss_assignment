import type { DataSource } from 'typeorm';
import { EventsService } from '../src/events/events.service.js';
import { EventsRepository } from '../src/worker/events.repository.js';
import {
  clearTables,
  connectTestDatabase,
  countProcessedOrders,
  createProcessor,
  expireLease,
  getAttempts,
  getEvent,
  processUntilIdle,
  sendEvent,
} from './helpers.js';

describe('Worker (integration, real Postgres)', () => {
  let db: DataSource;

  beforeAll(async () => {
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await clearTables(db);
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  it('5 workers running at the same time never process the same event twice', async () => {
    for (let i = 1; i <= 30; i++) {
      await sendEvent(db, `evt_${i}`);
    }

    const workers = [1, 2, 3, 4, 5].map((n) => createProcessor(db, { workerId: `worker-${n}` }));
    await Promise.all(workers.map((worker) => processUntilIdle(worker)));

    // Every event has exactly ONE attempt and ONE processed_orders row.
    const perEvent = await db.query<{ event_id: string; attempts: number }[]>(
      `SELECT event_id, count(*)::int AS attempts FROM event_attempts GROUP BY event_id`,
    );
    expect(perEvent).toHaveLength(30);
    expect(perEvent.every((row) => row.attempts === 1)).toBe(true);
    expect(await countProcessedOrders(db)).toBe(30);
  });

  // ── Retries ───────────────────────────────────────────────────────────────

  it('retries a temporarily failing event until it succeeds', async () => {
    await sendEvent(db, 'evt_temp', 'fail_then_succeed:2');

    await processUntilIdle(createProcessor(db, { maxAttempts: 3 }));

    expect((await getEvent(db, 'evt_temp')).status).toBe('completed');
    const attempts = await getAttempts(db, 'evt_temp');
    expect(attempts.map((a) => a.result)).toEqual(['failed', 'failed', 'succeeded']);
    expect(await countProcessedOrders(db, 'evt_temp')).toBe(1);
  });

  it('stops retrying and marks the event failed when the retry budget is used up', async () => {
    await sendEvent(db, 'evt_bad', 'always_fail');
    const processor = createProcessor(db, { maxAttempts: 3 });

    await processUntilIdle(processor);

    const event = await getEvent(db, 'evt_bad');
    expect(event.status).toBe('failed');
    expect(event.attempt_count).toBe(3);
    expect(event.last_error).toContain('always_fail');
    expect(await countProcessedOrders(db, 'evt_bad')).toBe(0);

    // Nothing left to pick up: retries really stopped.
    expect(await processor.processNext()).toBe(false);
  });

  it('manual retry gives a fresh budget while attempt numbers keep increasing', async () => {
    // Needs 4 failures, but only 3 attempts are allowed per budget.
    await sendEvent(db, 'evt_manual', 'fail_then_succeed:4');
    const processor = createProcessor(db, { maxAttempts: 3 });

    await processUntilIdle(processor);
    expect((await getEvent(db, 'evt_manual')).status).toBe('failed');

    await new EventsService(db).retry('evt_manual');
    expect(await getEvent(db, 'evt_manual')).toMatchObject({
      status: 'pending',
      attempt_count: 3,
      attempts_since_reset: 0,
    });

    await processUntilIdle(processor);

    expect((await getEvent(db, 'evt_manual')).status).toBe('completed');
    const attempts = await getAttempts(db, 'evt_manual');
    expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2, 3, 4, 5]);
    expect(attempts.map((a) => a.result)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'succeeded',
    ]);
  });

  // ── Crash recovery ────────────────────────────────────────────────────────

  it('another worker recovers an event whose worker crashed mid-processing', async () => {
    await sendEvent(db, 'evt_crash');

    // worker-1 claims the event and then "dies" (never finishes).
    const crashed = await new EventsRepository(db).claimNext('worker-1', 30);
    expect(crashed?.eventId).toBe('evt_crash');
    await expireLease(db, 'evt_crash'); // time passes, lease runs out

    await processUntilIdle(createProcessor(db, { workerId: 'worker-2' }));

    expect((await getEvent(db, 'evt_crash')).status).toBe('completed');
    const attempts = await getAttempts(db, 'evt_crash');
    expect(attempts).toEqual([
      { attempt_number: 1, worker_id: 'worker-1', result: 'abandoned' },
      { attempt_number: 2, worker_id: 'worker-2', result: 'succeeded' },
    ]);
    expect(await countProcessedOrders(db, 'evt_crash')).toBe(1);
  });

  it('recovery never creates a second processed_orders row, even if the first was already written', async () => {
    await sendEvent(db, 'evt_written');

    // worker-1 claims, writes the business row, then crashes before marking complete.
    await new EventsRepository(db).claimNext('worker-1', 30);
    await db.query(`INSERT INTO processed_orders (event_id, order_id) VALUES ('evt_written', 'ORD-evt_written')`);
    await expireLease(db, 'evt_written');

    await processUntilIdle(createProcessor(db, { workerId: 'worker-2' }));

    expect((await getEvent(db, 'evt_written')).status).toBe('completed');
    expect(await countProcessedOrders(db, 'evt_written')).toBe(1);
  });

  it('a worker that lost its lease cannot complete the event (only the new owner can)', async () => {
    await sendEvent(db, 'evt_slow');
    const repo = new EventsRepository(db);

    const oldClaim = await repo.claimNext('worker-1', 30); // attempt 1
    await expireLease(db, 'evt_slow');
    await repo.releaseExpiredLeases(3);
    const newClaim = await repo.claimNext('worker-2', 30); // attempt 2

    // worker-1 was only slow, not dead, and now tries to finish attempt 1.
    expect(await repo.completeEvent(oldClaim!, 'worker-1')).toBe(false);
    expect(await countProcessedOrders(db, 'evt_slow')).toBe(0);

    expect(await repo.completeEvent(newClaim!, 'worker-2')).toBe(true);
    expect(await countProcessedOrders(db, 'evt_slow')).toBe(1);
  });

  it('a worker crashing on the last allowed attempt marks the event failed (no endless crash loop)', async () => {
    await sendEvent(db, 'evt_poison');

    await new EventsRepository(db).claimNext('worker-1', 30); // attempt 1 of 1
    await expireLease(db, 'evt_poison');

    const processor = createProcessor(db, { workerId: 'worker-2', maxAttempts: 1 });
    expect(await processor.processNext()).toBe(false); // recovered, but nothing to claim

    const event = await getEvent(db, 'evt_poison');
    expect(event.status).toBe('failed');
    expect(event.last_error).toContain('Lease expired');
  });
});
