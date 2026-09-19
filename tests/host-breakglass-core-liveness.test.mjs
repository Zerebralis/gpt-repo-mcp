import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreLivenessWatchdog, assertCoreProbeResult } from '../scripts/host-breakglass-core-liveness.mjs';

const result = (pid = 42) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { pid } }) }] });
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
function fixture(calls = [], options = {}) {
  vi.useFakeTimers();
  const connections = [], failure = vi.fn(), states = [];
  const createConnection = vi.fn(() => {
    const c = { connect: vi.fn(async () => {}), call: vi.fn(async () => {
      const next = calls.shift();
      if (next instanceof Error) throw next;
      return next ?? result();
    }), close: vi.fn(async () => {}) };
    connections.push(c); return c;
  });
  const watchdog = createCoreLivenessWatchdog({ pid: 42, port: 12345 }, {
    createConnection, onFailure: failure, onState: s => states.push(s), ...options
  });
  watchdog.start();
  return { watchdog, connections, createConnection, failure, states };
}

describe('connector-local Core functional liveness', () => {
  it('counts timed out functional probes and fires exactly once after three, with no overlap', async () => {
    const hung = pending();
    const f = fixture([hung.promise, hung.promise, hung.promise]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.watchdog.state().failures).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.watchdog.state()).toMatchObject({ status: 'degraded', failures: 1 });
    await vi.advanceTimersByTimeAsync(35000);
    expect(f.watchdog.state().failures).toBe(2); expect(f.failure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(35000);
    expect(f.failure).toHaveBeenCalledTimes(1);
    expect(f.watchdog.state()).toMatchObject({ status: 'failed', failures: 3, probes: 3 });
    await vi.advanceTimersByTimeAsync(300000);
    expect(f.createConnection).toHaveBeenCalledTimes(3);
    expect(f.connections.every(c => c.call.mock.calls.length === 1 && c.close.mock.calls.length === 1)).toBe(true);
    hung.resolve(result()); await flush();
    expect(f.failure).toHaveBeenCalledTimes(1); expect(f.watchdog.state().status).toBe('failed');
    await f.watchdog.stop();
  });
  it('bounds the whole handshake, even if connect never settles', async () => {
    const connect = pending(), call = vi.fn(), close = vi.fn(async () => {});
    const f = fixture([], { createConnection: () => ({ connect: () => connect.promise, call, close }) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.watchdog.state().failures).toBe(1); expect(close).toHaveBeenCalledTimes(1);
    connect.resolve(); await flush(); expect(call).not.toHaveBeenCalled();
    await f.watchdog.stop();
  });
  it('rejects wrong PID, string PID, tool errors and ambiguous envelopes', () => {
    for (const response of [result(43), result('42'), { ...result(), isError: true }, { content: [...result().content, ...result().content] }, { content: [] }]) {
      expect(() => assertCoreProbeResult(response, 42)).toThrow();
    }
  });
  it('treats a wrong Core PID as a functional failure', async () => {
    const f = fixture([result(99)]); await flush();
    expect(f.watchdog.state()).toMatchObject({ status: 'degraded', failures: 1 });
    expect(f.failure).not.toHaveBeenCalled(); await f.watchdog.stop();
  });
  it('allows two transient errors; success resets the consecutive count', async () => {
    const error = new Error('transient');
    const f = fixture([error, error, result(), error, error]); await flush();
    await vi.advanceTimersByTimeAsync(30000); expect(f.watchdog.state().failures).toBe(2);
    await vi.advanceTimersByTimeAsync(30000); expect(f.watchdog.state()).toMatchObject({ status: 'ready', failures: 0 });
    await vi.advanceTimersByTimeAsync(60000); expect(f.watchdog.state().failures).toBe(2);
    expect(f.failure).not.toHaveBeenCalled(); await f.watchdog.stop();
  });
  it('preserves functional success with a separate audit warning, reusing the same connection', async () => {
    const success = result(); success.content.push({ type: 'text', text: JSON.stringify({ audit: { ok: false, code: 'HOST_BREAKGLASS_AUDIT_ERROR' } }) });
    const f = fixture([success]); await flush();
    await vi.advanceTimersByTimeAsync(90000);
    expect(f.watchdog.state()).toMatchObject({ status: 'ready', failures: 0, probes: 4 });
    expect(f.createConnection).toHaveBeenCalledTimes(1);
    expect(f.connections[0].call).toHaveBeenCalledTimes(4);
    expect(f.failure).not.toHaveBeenCalled(); await f.watchdog.stop();
    expect(f.connections[0].close).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'])('fences late old probe %s after a new session succeeds', async method => {
    const old = pending(); const f = fixture([old.promise, result()]);
    await vi.advanceTimersByTimeAsync(35000);
    expect(f.watchdog.state()).toMatchObject({ status: 'ready', failures: 0, probes: 2 });
    const state = f.watchdog.state();
    old[method](method === 'resolve' ? result(999) : Error('late')); await flush();
    expect(f.watchdog.state()).toEqual(state); expect(f.failure).not.toHaveBeenCalled();
    expect(f.connections[1].close).not.toHaveBeenCalled(); await f.watchdog.stop();
  });
  it('shutdown during a probe cancels timers and fences an entirely new watchdog generation', async () => {
    const old = pending(); const f = fixture([old.promise]); await flush();
    await f.watchdog.stop(); const state = f.watchdog.state(); const count = f.states.length;
    const next = fixture(); await flush();
    expect(next.watchdog.state().generation).not.toBe(state.generation);
    old.reject(Error('late failure')); await vi.advanceTimersByTimeAsync(120000);
    expect(f.watchdog.state()).toEqual(state); expect(f.states).toHaveLength(count);
    expect(f.failure).not.toHaveBeenCalled(); expect(next.failure).not.toHaveBeenCalled();
    expect(next.watchdog.state().status).toBe('ready');
    f.watchdog.start(); await flush(); expect(f.createConnection).toHaveBeenCalledTimes(1);
    await next.watchdog.stop();
  });
  it('does not create overlapping probes when start is called twice', async () => {
    const f = fixture(); f.watchdog.start(); await flush();
    expect(f.watchdog.state().probes).toBe(1);
    await f.watchdog.stop(); await vi.advanceTimersByTimeAsync(300000);
    expect(f.watchdog.state().probes).toBe(1);
  });
});
