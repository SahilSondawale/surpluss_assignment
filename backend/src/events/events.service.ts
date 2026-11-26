import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface AttemptView {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  result: 'succeeded' | 'failed' | 'abandoned' | null; // null = still running
  error: string | null;
}

export interface EventView {
  eventId: string;
  type: string;
  orderId: string | null;
  simulate: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attemptCount: number;
  attemptsSinceReset: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  nextAttemptAt: string;
  lastError: string | null;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  processed: boolean; // has a row in processed_orders
  attempts: AttemptView[];
}

export interface EventsOverview {
  counts: Record<string, number>; // events per status
  processedOrders: number; // rows in processed_orders
  events: EventView[];
}

/**
 * One row per event, newest first, with its attempts as a JSON array.
 * LEFT JOIN LATERAL = "for each event, run this small sub-query".
 */
const LIST_EVENTS_SQL = `
  SELECT
    e.event_id                      AS "eventId",
    e.type                          AS "type",
    e.payload -> 'data' ->> 'orderId'  AS "orderId",
    e.payload -> 'data' ->> 'simulate' AS "simulate",
    e.status                        AS "status",
    e.attempt_count                 AS "attemptCount",
    e.attempts_since_reset          AS "attemptsSinceReset",
    e.locked_by                     AS "lockedBy",
    e.locked_until                  AS "lockedUntil",
    e.next_attempt_at               AS "nextAttemptAt",
    e.last_error                    AS "lastError",
    e.received_at                   AS "receivedAt",
    e.updated_at                    AS "updatedAt",
    e.completed_at                  AS "completedAt",
    (p.event_id IS NOT NULL)        AS "processed",
    COALESCE(a.attempts, '[]'::json) AS "attempts"
  FROM events e
  LEFT JOIN processed_orders p ON p.event_id = e.event_id
  LEFT JOIN LATERAL (
    SELECT json_agg(
             json_build_object(
               'attemptNumber', ea.attempt_number,
               'workerId',      ea.worker_id,
               'startedAt',     ea.started_at,
               'finishedAt',    ea.finished_at,
               'result',        ea.result,
               'error',         ea.error
             )
             ORDER BY ea.attempt_number
           ) AS attempts
    FROM event_attempts ea
    WHERE ea.event_id = e.event_id
  ) a ON true
  WHERE ($1::text IS NULL OR e.status = $1)
  ORDER BY e.received_at DESC, e.event_id
  LIMIT $2
`;

const COUNT_BY_STATUS_SQL = `
  SELECT status, count(*)::int AS count FROM events GROUP BY status
`;

const COUNT_PROCESSED_ORDERS_SQL = `
  SELECT count(*)::int AS count FROM processed_orders
`;

/**
 * Manual retry: only for permanently failed events.
 * Fresh retry budget (attempts_since_reset = 0), but attempt_count keeps going.
 */
const MANUAL_RETRY_SQL = `
  UPDATE events
  SET status               = 'pending',
      attempts_since_reset = 0,
      next_attempt_at      = now(),
      updated_at           = now()
  WHERE event_id = $1
    AND status   = 'failed'
`;

@Injectable()
export class EventsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(status: string | undefined, limit: number): Promise<EventsOverview> {
    const [events, statusRows, processedRows] = await Promise.all([
      this.dataSource.query<EventView[]>(LIST_EVENTS_SQL, [status ?? null, limit]),
      this.dataSource.query<{ status: string; count: number }[]>(COUNT_BY_STATUS_SQL),
      this.dataSource.query<{ count: number }[]>(COUNT_PROCESSED_ORDERS_SQL),
    ]);

    const counts: Record<string, number> = { pending: 0, processing: 0, completed: 0, failed: 0 };
    for (const row of statusRows) {
      counts[row.status] = row.count;
    }

    return { counts, processedOrders: processedRows[0].count, events };
  }

  async retry(eventId: string): Promise<{ eventId: string; status: 'pending' }> {
    const [, affected] = await this.dataSource.query<[unknown[], number]>(MANUAL_RETRY_SQL, [eventId]);

    if (affected === 0) {
      // Find out why: unknown event, or not in 'failed' state?
      const rows = await this.dataSource.query<{ status: string }[]>(
        'SELECT status FROM events WHERE event_id = $1',
        [eventId],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`Event ${eventId} not found`);
      }
      throw new ConflictException(
        `Only failed events can be retried; ${eventId} is ${rows[0].status}`,
      );
    }

    return { eventId, status: 'pending' };
  }
}
