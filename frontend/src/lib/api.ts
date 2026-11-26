// Everything the page needs to talk to the NestJS backend.

/** Read at build time. The browser calls the backend directly (CORS is enabled there). */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Attempt {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  result: 'succeeded' | 'failed' | 'abandoned' | null; // null = still running
  error: string | null;
}

export interface WebhookEventRow {
  eventId: string;
  type: string;
  orderId: string | null;
  simulate: string | null;
  status: EventStatus;
  attemptCount: number;
  attemptsSinceReset: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  nextAttemptAt: string;
  lastError: string | null;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  processed: boolean;
  attempts: Attempt[];
}

export interface EventsOverview {
  counts: Record<EventStatus, number>;
  processedOrders: number;
  events: WebhookEventRow[];
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.message ?? response.statusText;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return body as T;
}

export async function fetchEvents(status?: EventStatus): Promise<EventsOverview> {
  const query = status ? `?status=${status}` : '';
  const response = await fetch(`${API_URL}/events${query}`, { cache: 'no-store' });
  return readJson<EventsOverview>(response);
}

export async function retryEvent(eventId: string): Promise<void> {
  const response = await fetch(`${API_URL}/events/${encodeURIComponent(eventId)}/retry`, {
    method: 'POST',
  });
  await readJson(response);
}

export interface NewWebhook {
  eventId: string;
  type: string;
  data: { orderId: string; customerId?: string; simulate?: string };
}

export async function sendWebhook(webhook: NewWebhook): Promise<void> {
  const response = await fetch(`${API_URL}/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhook),
  });
  await readJson(response);
}
