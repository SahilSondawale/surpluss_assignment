import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The "business action" is fake. `data.simulate` tells us how it should behave:
 *
 *   ok (or missing)       succeed
 *   fail_then_succeed:N   fail attempts 1..N, succeed from attempt N+1
 *   always_fail           fail every time
 *   slow:N                wait N seconds, then succeed
 */
export type Simulation =
  | { kind: 'ok' }
  | { kind: 'fail_then_succeed'; failures: number }
  | { kind: 'always_fail' }
  | { kind: 'slow'; seconds: number }
  | { kind: 'invalid'; value: string };

export function parseSimulation(value: string | undefined): Simulation {
  if (value === undefined || value === 'ok') return { kind: 'ok' };
  if (value === 'always_fail') return { kind: 'always_fail' };

  const [name, rawNumber] = value.split(':');
  const number = rawNumber ? Number(rawNumber) : NaN;

  if (name === 'fail_then_succeed' && Number.isInteger(number) && number >= 0) {
    return { kind: 'fail_then_succeed', failures: number };
  }
  if (name === 'slow' && Number.isFinite(number) && number >= 0) {
    return { kind: 'slow', seconds: number };
  }
  // The API already rejects bad values; this only protects against old or hand-edited rows.
  return { kind: 'invalid', value };
}

/** Thrown when the simulated business action fails. */
export class SimulatedFailure extends Error {}

/** Thrown when the worker lost its lease while waiting, so it must stop. */
export class LeaseLostError extends Error {}

/** Longest single setTimeout we use. Node can't wait more than ~24 days in one timer. */
const MAX_SLEEP_CHUNK_MS = 1000;

/**
 * Runs the simulated business action for one attempt.
 * Resolves on success, throws SimulatedFailure on failure.
 *
 * `isLeaseLost` lets a slow simulation stop early if another worker took over.
 */
export async function runSimulation(
  simulation: Simulation,
  attemptNumber: number,
  isLeaseLost: () => boolean,
): Promise<void> {
  switch (simulation.kind) {
    case 'ok':
      return;

    case 'always_fail':
      throw new SimulatedFailure('Simulated failure (always_fail)');

    case 'fail_then_succeed':
      if (attemptNumber <= simulation.failures) {
        throw new SimulatedFailure(
          `Simulated failure ${attemptNumber} of ${simulation.failures} (fail_then_succeed)`,
        );
      }
      return;

    case 'slow': {
      // Sleep in 1-second steps so we notice quickly if our lease was lost.
      let remainingMs = simulation.seconds * 1000;
      while (remainingMs > 0) {
        if (isLeaseLost()) {
          throw new LeaseLostError('Lease lost during slow processing');
        }
        const step = Math.min(remainingMs, MAX_SLEEP_CHUNK_MS);
        await sleep(step);
        remainingMs -= step;
      }
      return;
    }

    case 'invalid':
      throw new SimulatedFailure(`Unknown simulate value "${simulation.value}"`);
  }
}
