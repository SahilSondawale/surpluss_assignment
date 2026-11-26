import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { EventsService } from './events.service.js';

const listQuerySchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/** Read-side API for the operations page, plus manual retry. */
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /** GET /events?status=failed&limit=100 */
  @Get()
  list(@Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>) {
    return this.eventsService.list(query.status, query.limit);
  }

  /** POST /events/:eventId/retry → only for events in 'failed' state */
  @Post(':eventId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Param('eventId') eventId: string) {
    return this.eventsService.retry(eventId);
  }
}
