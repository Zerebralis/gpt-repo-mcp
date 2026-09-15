import { describe, expect, test } from 'vitest';
import { createReadinessWatchdog } from '../scripts/tunnel-readiness-watchdog.mjs';

describe('tunnel readiness watchdog', () => {
  test('trips after consecutive readiness failures', async () => {
    const scheduled = [];
    const failures = [];
    const trips = [];
    const watchdog = createReadinessWatchdog({
      probe: async () => false,
      failureThreshold: 3,
      intervalMs: 10,
      schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
      cancel: () => undefined,
      onFailure: (count) => failures.push(count),
      onThreshold: (count) => trips.push(count)
    });
    watchdog.start();
    for (let i = 0; i < 3; i += 1) await scheduled.shift().callback();
    expect(failures).toEqual([1, 2, 3]);
    expect(trips).toEqual([3]);
    expect(watchdog.state()).toEqual({ stopped: true, consecutiveFailures: 3 });
    expect(scheduled).toHaveLength(0);
  });

  test('a healthy probe resets the consecutive failure count', async () => {
    const scheduled = [];
    const sequence = [false, false, true, false, false, false];
    const healthy = [];
    const trips = [];
    const watchdog = createReadinessWatchdog({
      probe: async () => sequence.shift(),
      failureThreshold: 3,
      intervalMs: 10,
      schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
      cancel: () => undefined,
      onHealthy: (count) => healthy.push(count),
      onThreshold: (count) => trips.push(count)
    });
    watchdog.start();
    for (let i = 0; i < 6; i += 1) await scheduled.shift().callback();
    expect(healthy).toEqual([2]);
    expect(trips).toEqual([3]);
  });
});
