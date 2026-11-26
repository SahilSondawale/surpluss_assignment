import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ClaimedEvent, EventsRepository } from './events.repository.js';
import { LeaseHeartbeat } from './lease-heartbeat.js';
import { LeaseLostError, parseSimulation, runSimulation } from './simulator.js';
import { WORKER_CONFIG, type WorkerConfig, retryDelayMs } from './worker.config.js';

/**
 * Handles ONE event from start to finish:
 *
 *   recover expired leases → claim → run business action → success or failure
 */
@Injectable()
export class EventProcessor {
  private readonly logger = new Logger(EventProcessor.name);

  constructor(
    private readonly events: EventsRepository,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  /** Processes one event. Returns false if there was nothing to do. */
  async processNext(): Promise<boolean> {
    await this.recoverCrashedEvents();

    const event = await this.events.claimNext(this.config.workerId, this.config.leaseSeconds);
    if (!event) return false;

    await this.process(event);
    return true;
  }

  private async recoverCrashedEvents(): Promise<void> {
    const recovered = await this.events.releaseExpiredLeases(this.config.maxAttempts);
    for (const item of recovered) {
      this.logger.warn(
        `${this.config.workerId} recovered ${item.eventId} from an expired lease → ${item.newStatus}`,
      );
    }
  }

  private async process(event: ClaimedEvent): Promise<void> {
    const { workerId } = this.config;
    this.logger.log(`${workerId} claimed ${event.eventId} (attempt ${event.attemptNumber})`);

    // 1. Run the business action while the heartbeat keeps our lease alive.
    const heartbeat = new LeaseHeartbeat(this.events, event, this.config);
    let failure: Error | null = null;
    try {
      const simulation = parseSimulation(event.payload.data.simulate);
      await runSimulation(simulation, event.attemptNumber, () => heartbeat.isLeaseLost());
    } catch (err) {
      failure = err as Error;
    } finally {
      heartbeat.stop();
    }

    // 2. Lost the lease? Another worker owns the event now. Write nothing.
    if (heartbeat.isLeaseLost() || failure instanceof LeaseLostError) {
      this.logger.warn(`${workerId} gave up ${event.eventId}: lease lost, result discarded`);
      return;
    }

    // 3. Save the outcome.
    if (failure) {
      await this.saveFailure(event, failure.message);
    } else {
      await this.saveSuccess(event);
    }
  }

  private async saveSuccess(event: ClaimedEvent): Promise<void> {
    const { workerId } = this.config;
    const saved = await this.events.completeEvent(event, workerId);
    if (saved) {
      this.logger.log(`${workerId} completed ${event.eventId}`);
    } else {
      this.logger.warn(`${workerId} could not complete ${event.eventId}: no longer the owner`);
    }
  }

  private async saveFailure(event: ClaimedEvent, error: string): Promise<void> {
    const { workerId, maxAttempts } = this.config;
    const giveUp = event.attemptsSinceReset >= maxAttempts;
    const delayMs = retryDelayMs(this.config, event.attemptsSinceReset);

    const saved = await this.events.recordFailure(event, workerId, error, {
      giveUp,
      retryDelayMs: delayMs,
    });

    if (!saved) {
      this.logger.warn(`${workerId} could not record failure of ${event.eventId}: no longer the owner`);
    } else if (giveUp) {
      this.logger.error(
        `${workerId} ${event.eventId} FAILED permanently after ${event.attemptsSinceReset} attempts: ${error}`,
      );
    } else {
      this.logger.warn(`${workerId} ${event.eventId} failed (${error}); retry in ${delayMs}ms`);
    }
  }
}
