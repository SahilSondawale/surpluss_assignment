'use client';

import { Fragment, useState } from 'react';
import { type WebhookEventRow, retryEvent } from '@/lib/api';
import { AttemptHistory } from './AttemptHistory';
import { formatTime } from './format';

interface Props {
  events: WebhookEventRow[];
  onChanged: () => void;
}

/** One row per event. Click a row to see its attempt history. */
export function EventsTable({ events, onChanged }: Props) {
  const [openEventIds, setOpenEventIds] = useState<Set<string>>(new Set());
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  function toggle(eventId: string) {
    const next = new Set(openEventIds);
    if (next.has(eventId)) {
      next.delete(eventId);
    } else {
      next.add(eventId);
    }
    setOpenEventIds(next);
  }

  async function retry(eventId: string) {
    try {
      await retryEvent(eventId);
      setRetryMessage(`Retry scheduled for ${eventId}`);
      onChanged();
    } catch (err) {
      setRetryMessage(`Retry failed: ${(err as Error).message}`);
    }
  }

  if (events.length === 0) {
    return <p>No events yet. Use the buttons above or POST to /webhooks.</p>;
  }

  return (
    <>
      {retryMessage && <p className="info">{retryMessage}</p>}
      <table className="events">
        <thead>
          <tr>
            <th></th>
            <th>Event ID</th>
            <th>Order</th>
            <th>Simulate</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Worker</th>
            <th>Last error</th>
            <th>Received</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const isOpen = openEventIds.has(event.eventId);
            return (
              <Fragment key={event.eventId}>
                <tr className="event-row" onClick={() => toggle(event.eventId)}>
                  <td>{isOpen ? '▾' : '▸'}</td>
                  <td className="mono">{event.eventId}</td>
                  <td>{event.orderId}</td>
                  <td className="mono">{event.simulate ?? 'ok'}</td>
                  <td>
                    <span className={`badge status-${event.status}`}>{event.status}</span>
                  </td>
                  <td>
                    {event.attemptCount}
                    {event.attemptCount !== event.attemptsSinceReset && (
                      <span className="muted"> ({event.attemptsSinceReset} since retry)</span>
                    )}
                  </td>
                  <td>{event.lockedBy ?? '-'}</td>
                  <td className="error-text">{event.lastError ?? ''}</td>
                  <td>{formatTime(event.receivedAt)}</td>
                  <td>
                    {event.status === 'failed' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation(); // don't also open/close the row
                          void retry(event.eventId);
                        }}
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td></td>
                    <td colSpan={9}>
                      <AttemptHistory attempts={event.attempts} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
