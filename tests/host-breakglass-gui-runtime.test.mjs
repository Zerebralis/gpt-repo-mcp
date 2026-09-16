import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computerUseLaunchSpec, createGuiRuntime } from '../scripts/host-breakglass-gui-runtime.mjs';

afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const spec = { entry: 'fake', host: '127.0.0.1', port: 3107, url: 'http://127.0.0.1:3107/mcp' };
function fixture(options = {}) {
  vi.useFakeTimers();
  const children = [];
  const states = [];
  const probe = vi.fn(async () => {});
  const runtime = createGuiRuntime(spec, {
    startupMs: 100, stopMs: 10, backoffMs: [20, 50],
    checkEntry: async () => {}, probe,
    spawn: (generation) => {
      const child = new EventEmitter();
      Object.assign(child, { generation, pid: children.length + 100, connected: true, exitCode: null, signalCode: null });
      child.end = () => { child.exitCode = 1; child.emit('exit', 1, null); };
      child.send = vi.fn(() => child.end());
      child.kill = vi.fn(() => { child.end(); return true; });
      child.ready = () => child.emit('message', { type: 'listening', generation, pid: child.pid, address: { address: spec.host, port: spec.port } });
      children.push(child);
      return child;
    },
    onState: (state) => states.push(state), ...options
  });
  runtime.start();
  return { runtime, children, states, probe };
}

describe('optional GUI generation ownership', () => {
  it('bounds missing-runtime attempts with backoff, without any spawn', async () => {
    const f = fixture({ checkEntry: async () => { throw new Error('missing'); } });
    await flush();
    expect(f.runtime.state()).toMatchObject({ status: 'unavailable', attempts: 1 });
    await vi.advanceTimersByTimeAsync(19);
    expect(f.runtime.state().attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.state().attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.runtime.state()).toMatchObject({ attempts: 3, reason: 'retry_budget_exhausted' });
    await vi.advanceTimersByTimeAsync(100000);
    expect(f.children).toHaveLength(0);
    expect(f.runtime.state().attempts).toBe(3);
    await f.runtime.stop();
  });

  it('handles asynchronous spawn errors without waiting forever for an exit', async () => {
    const f = fixture(); await flush();
    f.children[0].pid = undefined;
    f.children[0].emit('error', new Error('ENOENT'));
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    expect(f.children).toHaveLength(2);
    await f.runtime.stop();
  });

  it('cleans up a readiness timeout before starting another generation', async () => {
    const f = fixture(); await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.children[0].send).toHaveBeenCalledExactlyOnceWith({ type: 'stop', generation: f.children[0].generation }, expect.any(Function));
    expect(f.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.children).toHaveLength(2);
    expect(f.children[0].exitCode).not.toBeNull();
    await f.runtime.stop();
  });

  it('requires own IPC identity, then MCP readiness; an HTTP port alone cannot be adopted', async () => {
    const f = fixture(); await flush();
    f.children[0].emit('message', { type: 'listening', generation: 'foreign', pid: 999, address: { port: 3107, address: '127.0.0.1' } });
    expect(f.probe).not.toHaveBeenCalled();
    f.children[0].ready(); await flush();
    expect(f.runtime.state().status).toBe('ready');
    expect(f.probe).toHaveBeenCalledTimes(1);
    await f.runtime.stop();
  });

  it('ignores old readiness/exit/timeout callbacks after crash and replacement', async () => {
    let release;
    const f = fixture({ probe: vi.fn().mockImplementationOnce(() => new Promise((r) => { release = r; })).mockResolvedValue(undefined) });
    await flush();
    const old = f.children[0]; old.ready(); await flush();
    old.end(); await flush();
    await vi.advanceTimersByTimeAsync(20);
    f.children[1].pid = old.pid; // PID reuse does not transfer generation ownership.
    f.children[1].ready(); await flush();
    const state = f.runtime.state();
    release(); old.emit('exit', 1); old.ready(); await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.runtime.state()).toEqual(state);
    expect(f.children[1].kill).not.toHaveBeenCalled();
    await f.runtime.stop();
  });

  it('keeps the retry budget across successful starts and subsequent crashes', async () => {
    const f = fixture(); await flush();
    for (let i = 0; i < 3; i++) {
      f.children[i].ready(); await flush();
      expect(f.runtime.state().status).toBe('ready');
      f.children[i].end(); await flush();
      if (i < 2) await vi.advanceTimersByTimeAsync([20, 50][i]);
    }
    expect(f.runtime.state()).toMatchObject({ status: 'degraded', reason: 'retry_budget_exhausted' });
    await vi.advanceTimersByTimeAsync(100000);
    expect(f.children).toHaveLength(3);
    await f.runtime.stop();
  });

  it('refuses replacement if cleanup cannot confirm exit', async () => {
    const f = fixture(); await flush();
    f.children[0].send.mockImplementation(() => {});
    f.children[0].kill.mockImplementation(() => false);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.runtime.state()).toMatchObject({ status: 'degraded', reason: 'cleanup_unconfirmed' });
    expect(f.children).toHaveLength(1);
    f.children[0].end();
    await f.runtime.stop();
  });

  it('fences pending readiness and retry callbacks before shutdown', async () => {
    let release;
    const f = fixture({ probe: () => new Promise((r) => { release = r; }) });
    await flush(); f.children[0].ready(); await flush();
    const state = f.runtime.state();
    await f.runtime.stop();
    release(); await flush();
    await vi.advanceTimersByTimeAsync(100000);
    f.runtime.start();
    expect(f.runtime.state()).toEqual(state);
    expect(f.children).toHaveLength(1);
  });

  it('shutdown during preflight cannot spawn a late child', async () => {
    let release;
    const f = fixture({ checkEntry: () => new Promise((r) => { release = r; }) });
    await f.runtime.stop(); release(); await flush();
    expect(f.children).toHaveLength(0);
  });

  it('shutdown cancels an already scheduled retry', async () => {
    const f = fixture({ checkEntry: async () => { throw new Error('missing'); } });
    await flush();
    await f.runtime.stop();
    await vi.advanceTimersByTimeAsync(100000);
    expect(f.runtime.state().attempts).toBe(1);
    expect(f.children).toHaveLength(0);
  });

  it.each(['https://127.0.0.1:3107/mcp', 'http://example.com/mcp', 'http://user:pass@127.0.0.1/mcp', 'http://127.0.0.1/mcp?x=1'])('rejects unsafe config: %s', (server_url) => {
    expect(() => computerUseLaunchSpec({ computer_use: { enabled: true, server_url } }, {}, '.', '.')).toThrow();
  });

  it('uses the same validated port and host for the backend and its probe', () => {
    const launch = computerUseLaunchSpec({ computer_use: { enabled: true, server_url: 'http://[::1]:3107/mcp' } }, {}, '.', '.');
    expect(launch).toMatchObject({ host: '::1', port: 3107, env: { COMPUTER_USE_HTTP_HOST: '::1', COMPUTER_USE_HTTP_PORT: '3107' } });
  });
});
