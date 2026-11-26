import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module.js';
import { EventProcessor } from './event-processor.js';
import { EventsRepository } from './events.repository.js';
import { WORKER_CONFIG, loadWorkerConfig } from './worker.config.js';
import { WorkerService } from './worker.service.js';

/** Root module of the worker process: config, database and the loop. No HTTP. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
  providers: [
    {
      provide: WORKER_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => loadWorkerConfig((key) => config.get<string>(key)),
    },
    EventsRepository,
    EventProcessor,
    WorkerService,
  ],
})
export class WorkerModule {}
