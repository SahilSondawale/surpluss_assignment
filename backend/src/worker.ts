import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module.js';
import { WorkerService } from './worker/worker.service.js';

async function bootstrap() {
  // createApplicationContext = NestJS without an HTTP server.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const worker = app.get(WorkerService);

  // Ctrl+C or `docker stop`: finish the current event, then exit cleanly.
  // (`docker kill` cannot be caught. That is the crash case, handled by leases.)
  const shutdown = (signal: string) => {
    new Logger('Worker').log(`${signal} received, finishing current event...`);
    worker.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await worker.run();
  await app.close();
}
await bootstrap();
