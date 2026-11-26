import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async check() {
    try {
      const [row] = await this.dataSource.query<{ now: Date }[]>('SELECT now() AS now');
      return { status: 'ok', database: 'connected', dbTime: row.now };
    } catch (err) {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unreachable',
        message: (err as Error).message,
      });
    }
  }
}
