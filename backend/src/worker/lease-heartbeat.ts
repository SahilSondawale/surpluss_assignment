import { Logger } from '@nestjs/common';
import type { ClaimedEvent, EventsRepository } from './events.repository.js';
import type { WorkerConfig } from './worker.config.js';

/**
 * While a worker is busy with an event, this keeps pushing the lease expiry
 * forward every few seconds ("I'm still alive").
 *
 * - Worker alive  → lease keeps getting extended → nobody else takes the event.
 * - Worker killed → heartbeats stop → lease expires → another worker recovers it.
 * - Extension refused (someone else owns the event now) → leaseLost becomes true,
 *   and the worker must stop and NOT write any result.
 */
export class LeaseHeartbeat {
  private readonly logger = new Logger(LeaseHeartbeat.name);
  private readonly timer: NodeJS.Timeout;
  private leaseLost = false;
  private busy = false;

  constructor(
    private readonly events: EventsRepository,
    private readonly event: ClaimedEvent,
    private readonly config: WorkerConfig,
  ) {
    this.timer = setInterval(() => void this.beat(), config.heartbeatSeconds * 1000);
  }

  isLeaseLost(): boolean {
    return this.leaseLost;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async beat(): Promise<void> {
    if (this.busy || this.leaseLost) return; // previous heartbeat still running
    this.busy = true;
    try {
      const stillOwned = await this.events.extendLease(
        this.event,
        this.config.workerId,
        this.config.leaseSeconds,
      );
      if (!stillOwned) {
        this.leaseLost = true;
        this.logger.warn(`${this.config.workerId} lost the lease on ${this.event.eventId}`);
      }
    } catch (err) {
      // Database hiccup: try again on the next beat. If it keeps failing,
      // the lease expires and another worker recovers the event.
      this.logger.error(`Heartbeat failed for ${this.event.eventId}: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
