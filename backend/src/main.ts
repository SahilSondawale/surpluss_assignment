import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The Next.js page (another origin, e.g. localhost:3000) calls this API from the browser.
  app.enableCors();

  // Close DB connections cleanly on `docker stop` / Ctrl+C.
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
