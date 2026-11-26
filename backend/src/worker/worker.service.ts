import { Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventProcessor } from './event-processor.js';
import { WORKER_CONFIG, type WorkerConfig } from './worker.config.js';

/**
 * Runs the processing loop. With WORKER_CONCURRENCY=2 it runs two loops side by
 * side in the same process, so one worker handles two events at the same time.
 */
@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);
  private stopping = false;

  constructor(
    private readonly processor: EventProcessor,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  /** Ask the loops to stop after their current event. */
  stop(): void {
    this.stopping = true;
  }

  /** Resolves once stop() has been called and every loop has finished. */
  async run(): Promise<void> {
    const c = this.config;
    this.logger.log(
      `${c.workerId} started: concurrency=${c.concurrency}, lease=${c.leaseSeconds}s, ` +
        `maxAttempts=${c.maxAttempts}, backoff=${c.retryBaseDelayMs}ms..${c.retryMaxDelayMs}ms`,
    );

    const loops: Promise<void>[] = [];
    for (let i = 0; i < c.concurrency; i++) {
      loops.push(this.loop());
    }
    await Promise.all(loops);

    this.logger.log(`${c.workerId} stopped`);
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const didWork = await this.processor.processNext();
        if (!didWork) {
          await sleep(this.config.pollIntervalMs); // nothing waiting
        }
      } catch (err) {
        // e.g. database briefly unreachable: wait and try again instead of crashing.
        this.logger.error(`${this.config.workerId} loop error: ${(err as Error).message}`);
        await sleep(this.config.pollIntervalMs);
      }
    }
  }
}
