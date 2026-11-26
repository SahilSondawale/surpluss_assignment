# Frontend (Next.js)

One operations page: event counts, every event with its status, attempts, worker and last error, and the attempt history (click a row). Failed events have a **Retry** button, and there are buttons to send test events.

| Command | What it does |
|---|---|
| `npm run dev` | http://localhost:3000 (expects the API at http://localhost:4000) |
| `npm run build` | Production build |
| `npm run lint` | Lint |

The API address comes from `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`). It is fixed when the app is built.

```
src/
├── app/page.tsx                  renders <Dashboard />
├── lib/api.ts                    types + fetch functions for the backend
└── components/
    ├── Dashboard.tsx             state, polling every 2s, summary, filter
    ├── SendEventsPanel.tsx       buttons that send demo webhooks
    ├── EventsTable.tsx           events table, expand row, Retry button
    ├── AttemptHistory.tsx        attempts of one event
    └── format.ts                 time/duration formatting
```
