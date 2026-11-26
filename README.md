# Reliable Webhook Processor

A NestJS API receives webhook events and stores them in PostgreSQL. Background workers (two containers) process them with retries, backoff and crash recovery. A Next.js page shows what is happening.

## Run it

```bash
docker compose up --build
```

| What | Where |
|---|---|
| Operations page | http://localhost:3000 |
| API | http://localhost:4000 (`POST /webhooks`, `GET /events`, `POST /events/:id/retry`, `GET /health`) |
| Postgres | `localhost:5432`, user/password/db: `webhook` / `webhook` / `webhooks` |

No other setup is needed. Ports 3000, 4000 and 5432 must be free (stop local dev servers first).

```bash
curl -X POST http://localhost:4000/webhooks -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_123","type":"order.created","data":{"orderId":"ORD-1001","customerId":"CUS-42","simulate":"fail_then_succeed:2"}}'
```

### Demo scenarios

`scripts/demo.sh` reproduces each scenario from the brief (bash + curl + docker; on Windows use Git Bash). The operations page also has a button for each one.

| Command | Shows |
|---|---|
| `./scripts/demo.sh duplicate` | Same `eventId` 10× at once → 1 event, 1 attempt, **1 `processed_orders` row** |
| `./scripts/demo.sh temporary` | `fail_then_succeed:2` → failed, failed, succeeded (backoff 1s, 2s) |
| `./scripts/demo.sh permanent` | `always_fail` → 5 attempts, then `failed`, and the attempt count stops growing |
| `./scripts/demo.sh parallel` | 4 × `slow:10` → both workers run events at the same time |
| `./scripts/demo.sh crash` | `slow:40`, then **`docker kill`** the worker running it → attempt 1 `abandoned`, the other worker completes attempt 2, still 1 `processed_orders` row |
| `./scripts/demo.sh burst` | 500 events at once → all `completed`, 500 `processed_orders` rows, `/health` stays fast |
| `./scripts/demo.sh status` | Counts per status |

To do the crash demo by hand: send `slow:40`, see which worker holds it on the page (`Worker` column), then `docker kill webhook-worker-1` (or `-2`). Within `LEASE_SECONDS` (15s), the other worker takes over.

### Tests

```bash
docker compose up -d postgres   # integration tests need Postgres (run from the repo root)
cd backend
npm install
npm test                        # unit: simulate parsing, backoff
npm run test:e2e                # integration against real Postgres (separate webhooks_test DB)
```

The integration tests cover: 5 workers racing over 30 events (each processed once); 10 simultaneous duplicate deliveries over HTTP (1 row); retry-then-success; permanent failure stops retrying; manual retry keeps attempt numbers increasing; crash recovery; a crash after the business row was written (still 1 row); a stale worker can't complete an event it lost; a crash on the final attempt ends as `failed`.

## Architecture

```
               POST /webhooks
  sender ───────────────────▶ API (NestJS) ──INSERT … ON CONFLICT DO NOTHING──▶ events (pending)
                               202 Accepted                                         │
                                                                                    │ poll
                                      ┌─────────────────────────────────────────────┤
                                      ▼                                             ▼
                                  worker-1                                      worker-2
                       1. recover expired leases                     (same loop, same code)
                       2. claim: SELECT … FOR UPDATE SKIP LOCKED
                          → status=processing, locked_by, locked_until, attempt_count+1
                          + insert event_attempts row          (one transaction)
                       3. run the business action (simulate), heartbeat extends the lease
                       4a. success: mark completed + insert processed_orders   (one transaction)
                       4b. failure: back to pending with next_attempt_at = now + backoff,
                           or failed when the retry budget is used up
```

**The `events` table is the queue.** No Redis is involved. An event's life:

```
pending ──claim──▶ processing ──success──▶ completed
   ▲                  │  │
   │   failure, retry │  │ failure, budget used up        crash: lease expires →
   └──────────────────┘  └──────────▶ failed               back to pending (or failed
   ▲                                    │                  if it was the last attempt)
   └──────────── manual retry ──────────┘
```

**Tables**
- `events`: one row per `eventId` (primary key): payload, status, `attempt_count` (never resets), `attempts_since_reset` (retry budget), `next_attempt_at` (backoff), `locked_by` / `locked_until` (lease), `last_error`.
- `processed_orders(event_id PK, order_id, processed_at)`: the business action, at most one row per event.
- `event_attempts`: one row per attempt: attempt number, worker, start, finish, result (`succeeded` / `failed` / `abandoned`), error. `UNIQUE(event_id, attempt_number)`.

**How workers coordinate**
- **Claiming:** `FOR UPDATE SKIP LOCKED` makes concurrent workers pick *different* rows without waiting on each other. The claim is committed straight away, so the row lock lasts only milliseconds.
- **Ownership:** the committed claim (`locked_by`, `locked_until`, `attempt_count`) is the lease. Each worker runs `WORKER_CONCURRENCY` (2) loops, so 2 containers process up to 4 events at once.
- **Heartbeat:** while working, a worker extends `locked_until` every `LEASE_SECONDS / 3`.
- **Recovery:** every loop first releases events whose lease has expired, marking the open attempt `abandoned`. All time checks use the database clock (`now()`), so container clocks don't matter.
- **Fencing:** every write after the claim includes `WHERE locked_by = me AND attempt_count = myAttempt`. A worker that lost its lease affects 0 rows, and its result is discarded.

## Libraries

| Library | Why |
|---|---|
| NestJS 12, Next.js 16, PostgreSQL 17 | Required stack |
| TypeORM + `pg` | Official NestJS integration, migrations, and plain parameterized SQL (`dataSource.query`), so the locking SQL is explicit and readable |
| Zod + NestJS `StandardSchemaValidationPipe` | Request validation from one schema, which also generates the TypeScript type |
| `@nestjs/config` | Env vars / `.env` |
| Vitest + Supertest | Bundled with the NestJS template. The integration tests use a real Postgres, because locking can't be meaningfully mocked |
| No queue library | Postgres already gives atomic claim + business write in one transaction. See Decisions |

## Correctness guarantees

1. **One event per `eventId`, first payload wins.** `events.event_id` is the primary key. Ingestion is a single `INSERT … ON CONFLICT DO NOTHING`, so simultaneous duplicates are decided by Postgres with no check-then-insert race. The response is `202` either way.
2. **Persisted before acknowledged.** `202` is sent only after the insert commits. If the DB is down, the sender gets an error and can redeliver.
3. **At most one `processed_orders` row per event.** It is enforced three ways: the primary key on `processed_orders.event_id`; `ON CONFLICT DO NOTHING`; and the row is written in the **same transaction** as `status = 'completed'`, guarded by the fencing check. A crash can't leave "row written but not completed": both commit or neither does. If a row does already exist (from any cause), recovery can't add a second one.
4. **Two workers never hold the same event at once** (while heartbeats work). `SKIP LOCKED` at claim time, then the lease. See limitation 1 for the edge case.
5. **Nothing stays in `processing` forever.** A CHECK constraint forces every `processing` row to have `locked_until`. Expired leases are released by any worker. If the lease ran out on the final allowed attempt, the event becomes `failed` instead of looping forever (a "poison" event can't crash workers endlessly).
6. **Retries stop.** Attempts are counted at claim time, so crashed attempts count too. After `MAX_ATTEMPTS` in the current budget, the event is `failed` and is never claimed again until a manual retry.
7. **`fail_then_succeed:N` follows attempt numbers.** Attempt numbers never reset, so `N` larger than `MAX_ATTEMPTS` fails permanently, and each manual retry continues the count until attempt `N+1` succeeds.
8. **Full attempt history.** The attempt row is inserted in the claim transaction, so even an attempt whose worker was `docker kill`ed is recorded (as `abandoned`).

## Known limitations

1. **The business action can run twice when a lease is lost, but its effect is recorded once.** If a worker can't reach the DB for longer than `LEASE_SECONDS` (15s in compose) while running a long `slow:N`, its heartbeats fail, the lease expires, and a second worker starts the same event while the first is still sleeping. The first notices within about 1s of its next failed heartbeat and stops; its writes are fenced off, so `processed_orders` still gets one row. With a real downstream side effect (an HTTP call), that call would have happened twice. It would need an idempotency key downstream (`eventId`).
2. **Execution is at-least-once.** After a crash, the event is processed again from scratch (`slow:40` restarts its 40 seconds). Only the database effect is exactly-once.
3. **Crash detection takes up to `LEASE_SECONDS`.** A killed worker's event waits until its lease expires (≤ 15s in compose, 30s default).
4. **`docker stop` on a busy worker** sends SIGTERM. The worker stops claiming and finishes its current events, but Docker sends SIGKILL after 10s, so a long `slow:N` becomes a normal crash recovery.
5. **Polling.** Idle workers query every `POLL_INTERVAL_MS` (500ms), which adds that much pickup latency and some constant DB load. Lease recovery is also attempted on every loop iteration (cheap thanks to a partial index, but it is an extra query).
6. **No backoff jitter.** Many events failing at the same moment retry at the same moment.
7. **No ordering.** Two events for the same order can be processed concurrently or out of order.
8. **Duplicates with a different payload are ignored silently** (logged, `202`). They aren't reported or compared.
9. **Validation rejects some inputs with `400`**: a missing `data.orderId` or an unknown `simulate` format. Any number is accepted for `N`.
10. **Unbounded growth.** There is no retention for `events` / `event_attempts`. The operations page shows the newest 200 events (the counts cover everything) and polls every 2s.
11. **The frontend's API URL is fixed at build time** (`NEXT_PUBLIC_API_URL`, default `http://localhost:4000`). The browser must be able to reach it.

## Decisions

- **Postgres as the queue instead of Redis/BullMQ.** The duplicate guarantee has to come from a Postgres constraint anyway, and with a Postgres queue the claim, the business write and the status change are all transactional in one system. A Redis job state can disagree with Postgres after a crash. It also means one fewer service to run and explain.
- **Short claim transaction + lease, not a row lock held during processing.** A lock held for the whole attempt would release itself on crash, but the rollback would also erase the attempt record and the attempt counter (so crash-looping events would never hit the retry limit), the `processing` state would be invisible to the page, and every in-flight event would occupy a DB connection.
- **Attempt counted at claim, not at the end**, so crashes use up retry budget.
- **The attempt number is the fencing token**: no extra column needed.
- **Two counters**: `attempt_count` (history, never resets, drives `fail_then_succeed`) and `attempts_since_reset` (retry budget, reset by manual retry).
- **Backoff:** exponential `1s × 2^(n-1)`, capped at 30s, with `MAX_ATTEMPTS=5` per budget. All configurable by env (`backend/.env.example`).
- **Manual retry only from `failed`**: `404` for an unknown event, `409` for any other state.
- **Raw SQL instead of ORM entities**, because the locking behaviour should be visible in the code.
- **A one-shot `migrate` container** runs the migrations before the API and workers start, so they never race to create tables.
- **Lease 15s in compose** (30s default) to keep the crash demo short. Heartbeat every 5s.
- **`202` body says `duplicate: true/false`**, for visibility. The status code is the same either way.

## What I'd do next

1. **Idempotency for real side effects**: pass `eventId` as an idempotency key to any downstream call. This is the remaining correctness gap (limitations 1–2).
2. **Metrics and alerts**: queue depth, age of the oldest pending event, failure rate, lease expiries. Without them, stuck or failing work is only visible on the page.
3. **`LISTEN/NOTIFY` wake-ups + jitter**: lower latency and less idle polling load, and no synchronized retry storms.
4. **Retention/archiving** for completed events and attempts, so the hot table stays small.
5. **Ingestion hardening**: rate limiting, payload-mismatch detection on duplicates (store a hash), batching for bursts.
6. **A CI job that runs the docker-compose demos**, including a real `docker kill`, alongside the integration tests.

## Project layout

```
docker-compose.yml     postgres, migrate, backend, worker-1, worker-2, frontend
scripts/demo.sh        demo scenarios
backend/               NestJS API + workers (see backend/README.md)
frontend/              Next.js operations page (src/components/Dashboard.tsx)
```
