import { hostname } from 'node:os';

/** Every setting the worker uses, in one place. */
export interface WorkerConfig {
  /** Name shown in logs and saved in event_attempts.worker_id. */
  workerId: string;
  /** How many events one worker process handles at the same time. */
  concurrency: number;
  /** How long a claim lasts before another worker may take the event over. */
  leaseSeconds: number;
  /** How often a busy worker extends its lease ("I'm still alive"). */
  heartbeatSeconds: number;
  /** How long to wait before asking again when there is no work. */
  pollIntervalMs: number;
  /** Attempts allowed per retry budget before the event is marked failed. */
  maxAttempts: number;
  /** Wait after the 1st failure. Doubles after each further failure. */
  retryBaseDelayMs: number;
  /** The wait between retries never grows beyond this. */
  retryMaxDelayMs: number;
}

/** The name NestJS uses to find the WorkerConfig object when injecting it. */
export const WORKER_CONFIG = 'WORKER_CONFIG';

type EnvReader = (key: string) => string | undefined;

function readNumber(env: EnvReader, key: string, fallback: number, min: number): number {
  const raw = env(key);
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
}

/** Builds the config from environment variables, with safe defaults. */
export function loadWorkerConfig(env: EnvReader): WorkerConfig {
  const leaseSeconds = readNumber(env, 'LEASE_SECONDS', 30, 1);

  return {
    workerId: env('WORKER_ID') || `worker-${hostname()}-${process.pid}`,
    concurrency: Math.floor(readNumber(env, 'WORKER_CONCURRENCY', 2, 1)),
    leaseSeconds,
    // Extend the lease 3 times per lease period, so one missed heartbeat is not fatal.
    heartbeatSeconds: leaseSeconds / 3,
    pollIntervalMs: readNumber(env, 'POLL_INTERVAL_MS', 500, 10),
    maxAttempts: Math.floor(readNumber(env, 'MAX_ATTEMPTS', 5, 1)),
    retryBaseDelayMs: readNumber(env, 'RETRY_BASE_DELAY_MS', 1000, 0),
    retryMaxDelayMs: readNumber(env, 'RETRY_MAX_DELAY_MS', 30000, 0),
  };
}

/**
 * Exponential backoff: 1s, 2s, 4s, 8s ... capped at retryMaxDelayMs.
 * `failedAttempts` is how many attempts have failed in the current retry budget.
 */
export function retryDelayMs(config: WorkerConfig, failedAttempts: number): number {
  const delay = config.retryBaseDelayMs * 2 ** (failedAttempts - 1);
  return Math.min(delay, config.retryMaxDelayMs);
}
