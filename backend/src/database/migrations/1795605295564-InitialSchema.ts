import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1795605295564 implements MigrationInterface {
  name = 'InitialSchema1795605295564';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── events: one row per webhook eventId (the "inbox" / job queue) ───
    await queryRunner.query(`
      CREATE TABLE events (
        event_id             text        PRIMARY KEY,
        type                 text        NOT NULL,
        payload              jsonb       NOT NULL,

        status               text        NOT NULL DEFAULT 'pending',
        attempt_count        integer     NOT NULL DEFAULT 0,
        attempts_since_reset integer     NOT NULL DEFAULT 0,
        next_attempt_at      timestamptz NOT NULL DEFAULT now(),

        locked_by            text,
        locked_until         timestamptz,

        last_error           text,
        received_at          timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        completed_at         timestamptz,

        CONSTRAINT events_status_check
          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        CONSTRAINT events_attempt_count_check
          CHECK (attempt_count >= 0 AND attempts_since_reset >= 0),
        CONSTRAINT events_processing_has_lease_check
          CHECK (status <> 'processing' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL))
      )
    `);

    // Workers look for "pending events that are due now".
    await queryRunner.query(`
      CREATE INDEX events_due_idx
        ON events (next_attempt_at)
        WHERE status = 'pending'
    `);

    // Workers also look for "processing events whose lease has expired" (crashed workers).
    await queryRunner.query(`
      CREATE INDEX events_expired_lease_idx
        ON events (locked_until)
        WHERE status = 'processing'
    `);

    // The operations page lists the newest events first.
    await queryRunner.query(`
      CREATE INDEX events_received_at_idx
        ON events (received_at DESC)
    `);

    // ─── processed_orders: the record of real work done (exactly one row per event) ───
    await queryRunner.query(`
      CREATE TABLE processed_orders (
        event_id     text        PRIMARY KEY REFERENCES events (event_id),
        order_id     text        NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ─── event_attempts: history of every processing attempt ───
    await queryRunner.query(`
      CREATE TABLE event_attempts (
        id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id       text        NOT NULL REFERENCES events (event_id),
        attempt_number integer     NOT NULL,
        worker_id      text        NOT NULL,
        started_at     timestamptz NOT NULL DEFAULT now(),
        finished_at    timestamptz,
        result         text,
        error          text,

        CONSTRAINT event_attempts_event_attempt_unique
          UNIQUE (event_id, attempt_number),
        CONSTRAINT event_attempts_result_check
          CHECK (result IS NULL OR result IN ('succeeded', 'failed', 'abandoned'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order: child tables first, because they reference events.
    await queryRunner.query(`DROP TABLE event_attempts`);
    await queryRunner.query(`DROP TABLE processed_orders`);
    await queryRunner.query(`DROP TABLE events`);
  }
}
