'use client';

import { useCallback, useEffect, useState } from 'react';
import { type EventStatus, type EventsOverview, fetchEvents } from '@/lib/api';
import { EventsTable } from './EventsTable';
import { SendEventsPanel } from './SendEventsPanel';

const REFRESH_EVERY_MS = 2000;
const STATUSES: EventStatus[] = ['pending', 'processing', 'completed', 'failed'];

/** The whole operations page: summary, test buttons, and the events table. */
export function Dashboard() {
  const [overview, setOverview] = useState<EventsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<EventStatus | ''>('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchEvents(statusFilter || undefined);
      setOverview(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [statusFilter]);

  // Load now, then every 2 seconds while auto-refresh is on.
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = autoRefresh ? setInterval(() => void refresh(), REFRESH_EVERY_MS) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, autoRefresh]);

  return (
    <main>
      <h1>Webhook Processor: Operations</h1>

      {error && <p className="error-banner">Cannot reach the backend: {error}</p>}

      <section className="summary">
        {STATUSES.map((status) => (
          <div key={status} className={`summary-card status-${status}`}>
            <span className="summary-number">{overview?.counts[status] ?? '-'}</span>
            <span>{status}</span>
          </div>
        ))}
        <div className="summary-card">
          <span className="summary-number">{overview?.processedOrders ?? '-'}</span>
          <span>processed_orders rows</span>
        </div>
      </section>

      <SendEventsPanel onSent={refresh} />

      <section className="toolbar">
        <label>
          Show:{' '}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EventStatus | '')}
          >
            <option value="">all events</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />{' '}
          Auto-refresh every 2s
        </label>
        <button onClick={() => void refresh()}>Refresh now</button>
      </section>

      {overview ? (
        <EventsTable events={overview.events} onChanged={refresh} />
      ) : (
        !error && <p>Loading…</p>
      )}
    </main>
  );
}
