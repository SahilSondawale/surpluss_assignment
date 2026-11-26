'use client';

import { useState } from 'react';
import { type NewWebhook, sendWebhook } from '@/lib/api';

/** A unique id like "evt_k3j9x2" so every click creates new events. */
function newEventId(): string {
  return `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function makeWebhook(simulate?: string, eventId = newEventId()): NewWebhook {
  return {
    eventId,
    type: 'order.created',
    data: { orderId: `ORD-${eventId.slice(4)}`, customerId: 'CUS-42', ...(simulate && { simulate }) },
  };
}

/** Buttons that send test webhooks, one per demo scenario. */
export function SendEventsPanel({ onSent }: { onSent: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(label: string, webhooks: NewWebhook[]) {
    setBusy(true);
    try {
      // Send them all at the same time.
      await Promise.all(webhooks.map((webhook) => sendWebhook(webhook)));
      setMessage(`Sent: ${label}`);
      onSent();
    } catch (err) {
      setMessage(`Failed to send: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function repeat(count: number, create: () => NewWebhook): NewWebhook[] {
    return Array.from({ length: count }, create);
  }

  function sendDuplicates() {
    const webhook = makeWebhook(); // one event...
    void send(`5 copies of ${webhook.eventId}`, repeat(5, () => webhook)); // ...sent 5 times
  }

  return (
    <section className="send-panel">
      <strong>Send test events:</strong>
      <button disabled={busy} onClick={() => send('1 × ok', [makeWebhook('ok')])}>
        ok
      </button>
      <button
        disabled={busy}
        onClick={() => send('fail_then_succeed:2', [makeWebhook('fail_then_succeed:2')])}
      >
        fail_then_succeed:2
      </button>
      <button disabled={busy} onClick={() => send('always_fail', [makeWebhook('always_fail')])}>
        always_fail
      </button>
      <button
        disabled={busy}
        onClick={() => send('4 × slow:20', repeat(4, () => makeWebhook('slow:20')))}
      >
        4 × slow:20
      </button>
      <button disabled={busy} onClick={sendDuplicates}>
        5 × same eventId
      </button>
      <button disabled={busy} onClick={() => send('500 × ok', repeat(500, () => makeWebhook()))}>
        burst 500
      </button>
      {message && <span className="info">{message}</span>}
    </section>
  );
}
