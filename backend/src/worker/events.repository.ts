import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import type { WebhookEvent } from '../webhooks/webhook-event.schema.js';

/** An event a worker has claimed and is now responsible for. */
export interface ClaimedEvent {
  eventId: string;
  type: string;
  payload: WebhookEvent;
  /** Total attempt number, never resets (1, 2, 3 ...). Also our "ownership ticket". */
  attemptNumber: number;
  /** Attempts used in the current retry budget (resets on manual retry). */
  attemptsSinceReset: number;
}

export interface RecoveredEvent {
  eventId: string;
  newStatus: 'pending' | 'failed';
}

const LEASE_EXPIRED_MESSAGE = 'Lease expired: the worker crashed or stopped responding';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CRASH RECOVERY
// Events stuck in 'processing' whose lease has run out belong to a worker that
// crashed (or froze). Hand them back: 'pending' to retry, or 'failed' if that
// was their last allowed attempt.
// ─────────────────────────────────────────────────────────────────────────────
const RELEASE_EXPIRED_LEASES_SQL = `
  UPDATE events
  SET status          = CASE WHEN attempts_since_reset >= $1 THEN 'failed' ELSE 'pending' END,
      next_attempt_at = now(),
      last_error      = $2,
      locked_by       = NULL,
      locked_until    = NULL,
      updated_at      = now()
  WHERE status = 'processing'
    AND locked_until < now()
  RETURNING event_id, attempt_count, status
`;

const MARK_ATTEMPT_ABANDONED_SQL = `
  UPDATE event_attempts
  SET finished_at = now(),
      result      = 'abandoned',
      error       = $3
  WHERE event_id       = $1
    AND attempt_number = $2
    AND finished_at IS NULL
`;

// ─────────────────────────────────────────────────────────────────────────────
// 2. CLAIM
// Pick one due event, lock it (skipping rows other workers have locked),
// and save the claim on the row.
// ─────────────────────────────────────────────────────────────────────────────
const CLAIM_NEXT_EVENT_SQL = `
  WITH next_event AS (
    SELECT event_id
    FROM events
    WHERE status = 'pending'
      AND next_attempt_at <= now()
    ORDER BY next_attempt_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE events AS e
  SET status               = 'processing',
      locked_by            = $1,
      locked_until         = now() + make_interval(secs => $2),
      attempt_count        = e.attempt_count + 1,
      attempts_since_reset = e.attempts_since_reset + 1,
      updated_at           = now()
  FROM next_event
  WHERE e.event_id = next_event.event_id
  RETURNING e.event_id, e.type, e.payload, e.attempt_count, e.attempts_since_reset
`;

const INSERT_ATTEMPT_SQL = `
  INSERT INTO event_attempts (event_id, attempt_number, worker_id)
  VALUES ($1, $2, $3)
`;

// ─────────────────────────────────────────────────────────────────────────────
// 3. HEARTBEAT
// "I'm still working on it": push the lease expiry forward.
// Only works while we still own the event.
// ─────────────────────────────────────────────────────────────────────────────
const EXTEND_LEASE_SQL = `
  UPDATE events
  SET locked_until = now() + make_interval(secs => $4),
      updated_at   = now()
  WHERE event_id      = $1
    AND status        = 'processing'
    AND locked_by     = $2
    AND attempt_count = $3
`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. SUCCESS
// Mark completed AND write processed_orders in ONE transaction.
// The ownership check (locked_by + attempt_count) means a worker that lost
// its lease can't complete the event. ON CONFLICT DO NOTHING plus the primary
// key on processed_orders.event_id guarantee at most one row per event.
// ─────────────────────────────────────────────────────────────────────────────
const MARK_COMPLETED_SQL = `
  UPDATE events
  SET status       = 'completed',
      locked_by    = NULL,
      locked_until = NULL,
      last_error   = NULL,
      completed_at = now(),
      updated_at   = now()
  WHERE event_id      = $1
    AND status        = 'processing'
    AND locked_by     = $2
    AND attempt_count = $3
`;

const INSERT_PROCESSED_ORDER_SQL = `
  INSERT INTO processed_orders (event_id, order_id)
  VALUES ($1, $2)
  ON CONFLICT (event_id) DO NOTHING
`;

// ─────────────────────────────────────────────────────────────────────────────
// 5. FAILURE
// Back to 'pending' with a later next_attempt_at (backoff),
// or 'failed' if the retry budget is used up.
// ─────────────────────────────────────────────────────────────────────────────
const MARK_FAILED_ATTEMPT_SQL = `
  UPDATE events
  SET status          = $4,
      next_attempt_at = now() + make_interval(secs => $5),
      last_error      = $6,
      locked_by       = NULL,
      locked_until    = NULL,
      updated_at      = now()
  WHERE event_id      = $1
    AND status        = 'processing'
    AND locked_by     = $2
    AND attempt_count = $3
`;

const FINISH_ATTEMPT_SQL = `
  UPDATE event_attempts
  SET finished_at = now(),
      result      = $3,
      error       = $4
  WHERE event_id       = $1
    AND attempt_number = $2
`;

/** All SQL the worker runs lives here. */
@Injectable()
export class EventsRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Finds events whose worker died and makes them available again. */
  async releaseExpiredLeases(maxAttempts: number): Promise<RecoveredEvent[]> {
    return this.inTransaction(async (db) => {
      const released = await db.query(
        RELEASE_EXPIRED_LEASES_SQL,
        [maxAttempts, LEASE_EXPIRED_MESSAGE],
        true,
      );

      const recovered: RecoveredEvent[] = [];
      for (const row of released.records) {
        await db.query(MARK_ATTEMPT_ABANDONED_SQL, [
          row.event_id,
          row.attempt_count,
          LEASE_EXPIRED_MESSAGE,
        ]);
        recovered.push({ eventId: row.event_id, newStatus: row.status });
      }
      return recovered;
    });
  }

  /** Claims the next due event. Returns null if nothing is waiting. */
  async claimNext(workerId: string, leaseSeconds: number): Promise<ClaimedEvent | null> {
    return this.inTransaction(async (db) => {
      const claimed = await db.query(CLAIM_NEXT_EVENT_SQL, [workerId, leaseSeconds], true);
      const row = claimed.records[0];
      if (!row) return null;

      // Same transaction: the claim and the "attempt started" record are saved together.
      await db.query(INSERT_ATTEMPT_SQL, [row.event_id, row.attempt_count, workerId]);

      return {
        eventId: row.event_id,
        type: row.type,
        payload: row.payload,
        attemptNumber: row.attempt_count,
        attemptsSinceReset: row.attempts_since_reset,
      };
    });
  }

  /** Returns false if we no longer own the event. */
  async extendLease(event: ClaimedEvent, workerId: string, leaseSeconds: number): Promise<boolean> {
    // A single statement needs no explicit transaction.
    // For UPDATE statements dataSource.query returns [rows, affectedCount].
    const [, affected] = await this.dataSource.query<[unknown[], number]>(EXTEND_LEASE_SQL, [
      event.eventId,
      workerId,
      event.attemptNumber,
      leaseSeconds,
    ]);
    return affected > 0;
  }

  /** Success: completed + processed_orders row. Returns false if we no longer own the event. */
  async completeEvent(event: ClaimedEvent, workerId: string): Promise<boolean> {
    return this.inTransaction(async (db) => {
      const updated = await db.query(
        MARK_COMPLETED_SQL,
        [event.eventId, workerId, event.attemptNumber],
        true,
      );
      if (updated.affected === 0) return false; // someone else owns it now

      await db.query(INSERT_PROCESSED_ORDER_SQL, [event.eventId, event.payload.data.orderId]);
      await db.query(FINISH_ATTEMPT_SQL, [event.eventId, event.attemptNumber, 'succeeded', null]);
      return true;
    });
  }

  /** Failure: schedule a retry or give up. Returns false if we no longer own the event. */
  async recordFailure(
    event: ClaimedEvent,
    workerId: string,
    error: string,
    options: { giveUp: boolean; retryDelayMs: number },
  ): Promise<boolean> {
    const newStatus = options.giveUp ? 'failed' : 'pending';
    const delaySeconds = options.giveUp ? 0 : options.retryDelayMs / 1000;
    const shortError = error.slice(0, 2000);

    return this.inTransaction(async (db) => {
      const updated = await db.query(
        MARK_FAILED_ATTEMPT_SQL,
        [event.eventId, workerId, event.attemptNumber, newStatus, delaySeconds, shortError],
        true,
      );
      if (updated.affected === 0) return false;

      await db.query(FINISH_ATTEMPT_SQL, [event.eventId, event.attemptNumber, 'failed', shortError]);
      return true;
    });
  }

  /**
   * Runs `work` inside BEGIN ... COMMIT on one connection.
   * If anything throws, everything is rolled back (ROLLBACK).
   * Note: `db.query(sql, params, true)` returns { records, affected }.
   */
  private async inTransaction<T>(work: (db: QueryRunner) => Promise<T>): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const result = await work(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release(); // always give the connection back to the pool
    }
  }
}
