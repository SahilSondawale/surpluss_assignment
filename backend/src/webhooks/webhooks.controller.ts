import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { webhookEventSchema, type WebhookEvent } from './webhook-event.schema.js';
import { WebhooksService } from './webhooks.service.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED) // 202 for both new and duplicate deliveries
  async receive(@Body({ schema: webhookEventSchema }) event: WebhookEvent) {
    const { duplicate } = await this.webhooksService.ingest(event);
    return { eventId: event.eventId, status: 'accepted', duplicate };
  }
}
