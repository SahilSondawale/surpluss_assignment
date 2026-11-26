import { SimulatedFailure, parseSimulation, runSimulation } from './simulator.js';
import { retryDelayMs } from './worker.config.js';

const neverLost = () => false;

describe('parseSimulation', () => {
  it.each([
    [undefined, { kind: 'ok' }],
    ['ok', { kind: 'ok' }],
    ['always_fail', { kind: 'always_fail' }],
    ['fail_then_succeed:2', { kind: 'fail_then_succeed', failures: 2 }],
    ['slow:1.5', { kind: 'slow', seconds: 1.5 }],
    ['fail_then_succeed:', { kind: 'invalid', value: 'fail_then_succeed:' }],
    ['explode', { kind: 'invalid', value: 'explode' }],
  ])('%s', (input, expected) => {
    expect(parseSimulation(input)).toEqual(expected);
  });
});

describe('runSimulation', () => {
  it('fail_then_succeed:2 fails attempts 1 and 2, succeeds from attempt 3', async () => {
    const simulation = parseSimulation('fail_then_succeed:2');
    await expect(runSimulation(simulation, 1, neverLost)).rejects.toBeInstanceOf(SimulatedFailure);
    await expect(runSimulation(simulation, 2, neverLost)).rejects.toBeInstanceOf(SimulatedFailure);
    await expect(runSimulation(simulation, 3, neverLost)).resolves.toBeUndefined();
  });

  it('always_fail fails on every attempt', async () => {
    await expect(runSimulation({ kind: 'always_fail' }, 99, neverLost)).rejects.toThrow('always_fail');
  });

  it('slow stops early when the lease is lost', async () => {
    const started = Date.now();
    await expect(runSimulation({ kind: 'slow', seconds: 60 }, 1, () => true)).rejects.toThrow(
      'Lease lost',
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('retryDelayMs (exponential backoff)', () => {
  const config = { retryBaseDelayMs: 1000, retryMaxDelayMs: 10_000 } as Parameters<typeof retryDelayMs>[0];

  it('doubles after each failure and stops at the maximum', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => retryDelayMs(config, n))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });
});
