# Backend (NestJS)

API and workers for the webhook processor. See the [main README](../README.md) for the architecture and decisions.

| Command | What it does |
|---|---|
| `npm run start:dev` | API on http://localhost:4000 (reloads on change) |
| `npm run start:worker` | One worker (runs the compiled code in `dist/`; set `WORKER_ID` per terminal) |
| `npm run migration:run` | Create/update tables |
| `npm test` | Unit tests (no database) |
| `npm run test:e2e` | Integration tests against Postgres (`docker compose up -d postgres` first) |
| `npm run lint` | Lint |

## Source layout

```
src/
├── main.ts                 API entry point
├── worker.ts               Worker entry point (no HTTP server)
├── app.module.ts           Root module of the API
├── database/               Connection, data-source for the CLI, migrations
├── webhooks/               POST /webhooks: validate and store events
├── events/                 GET /events, POST /events/:id/retry (operations page)
├── health/                 GET /health
└── worker/
    ├── worker.module.ts    Root module of the worker
    ├── worker.config.ts    Settings from env vars + backoff formula
    ├── worker.service.ts   The loop(s)
    ├── event-processor.ts  One event: recover → claim → run → save result
    ├── events.repository.ts All worker SQL (claim, heartbeat, complete, fail, recover)
    ├── lease-heartbeat.ts  Keeps the lease alive while working
    └── simulator.ts        The fake business action (data.simulate)
```
