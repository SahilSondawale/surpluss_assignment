import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WebhookEvent } from './webhook-event.schema.js';

export interface IngestResult {
  duplicate: boolean;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Saves the event so a worker can process it later.
   *
   * If an event with the same eventId already exists, nothing is changed
   * (the first payload wins). Postgres decides this atomically through the
   * primary key, so it is also correct when copies arrive at the same time.
   */
  async ingest(event: WebhookEvent): Promise<IngestResult> {
    const inserted = await this.dataSource.query<{ event_id: string }[]>(
      `INSERT INTO events (event_id, type, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.eventId, event.type, JSON.stringify(event)],
    );

    const duplicate = inserted.length === 0;

    if (duplicate) {
      this.logger.log(`Duplicate delivery ignored: ${event.eventId}`);
    } else {
      this.logger.log(`Event stored: ${event.eventId} (${event.type})`);
    }

    return { duplicate };
  }
}
