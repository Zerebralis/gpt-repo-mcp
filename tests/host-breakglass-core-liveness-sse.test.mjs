/* global AbortController, Request, Response, URL, setTimeout */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from 'node:http';
import { createCoreProbeFetch, createCoreLivenessWatchdog } from '../scripts/host-breakglass-core-liveness.mjs';

const url = 'http://127.0.0.1:12345/mcp';
const response = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-private' } });
const toolResult = pid => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { pid } }) }] });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('private watchdog method boundary', () => {
  it('returns a bodyless local 405 for only its exact private GET', async () => {
    const network = vi.fn(), f = createCoreProbeFetch(url, new AbortController().signal, network);
    for (const target of [url, new URL(url), new Request(url)]) {
      const r = await f(target); expect(r.status).toBe(405); expect(r.body).toBeNull();
    }
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['initialize', 'notifications/initialized', 'tools/call'])('keeps %s POST real', async method => {
    const real = new Response('real'), network = vi.fn(async () => real);
    const f = createCoreProbeFetch(url, new AbortController().signal, network);
    const init = { method: 'POST', body: JSON.stringify({ method }), headers: { 'content-type': 'application/json' } };
    expect(await f(url, init)).toBe(real); expect(network).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining(init));
  });
  it.each(['DELETE', 'HEAD', 'OPTIONS', 'PATCH'])('does not suppress %s', async method => {
    const network = vi.fn(async () => new Response(null, { status: 202 }));
    const f = createCoreProbeFetch(url, new AbortController().signal, network);
    expect((await f(url, { method })).status).toBe(202); expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['http://127.0.0.1:12346/mcp', 'http://127.0.0.1:12345/other', 'http://127.0.0.1:12345/mcp?x=1', 'http://localhost:12345/mcp'])('does not suppress GET to another target %s', async target => {
    const network = vi.fn(async () => new Response('network'));
    const f = createCoreProbeFetch(url, new AbortController().signal, network);
    expect(await (await f(target, { method: 'GET' })).text()).toBe('network'); expect(network).toHaveBeenCalledTimes(1);
  });
  it('classifies Request method and explicit method override correctly', async () => {
    const network = vi.fn(async () => new Response('network'));
    const f = createCoreProbeFetch(url, new AbortController().signal, network);
    await f(new Request(url, { method: 'POST', body: '{}' })); expect(network).toHaveBeenCalledTimes(1);
    expect((await f(new Request(url), { method: 'POST', body: '{}' })).status).toBe(200); expect(network).toHaveBeenCalledTimes(2);
  });
  it('retains cancellation and redirect rejection', async () => {
    const lifetime = new AbortController(), request = new AbortController();
    const network = vi.fn(async () => new Response());
    const f = createCoreProbeFetch(url, lifetime.signal, network);
    await f(url, { method: 'POST', signal: request.signal });
    const init = network.mock.calls[0][1]; expect(init.redirect).toBe('error'); request.abort(); expect(init.signal.aborted).toBe(true);
    lifetime.abort(); await expect(f(url, { method: 'GET' })).rejects.toThrow(); expect(network).toHaveBeenCalledTimes(1);
  });
  it('rejects a non-private endpoint configuration', () => {
    for (const endpoint of ['https://127.0.0.1/mcp', 'http://example.com/mcp', url + '?x=1', url + '#x', 'http://user@127.0.0.1/mcp']) expect(() => createCoreProbeFetch(endpoint, new AbortController().signal)).toThrow();
  });
});

function virtualSdk() {
  vi.useFakeTimers();
  const rpc = [], methods = [], states = [], failures = vi.fn();
  const connects = vi.spyOn(Client.prototype, 'connect');
  let fault = false;
  const network = vi.fn(async (target, init = {}) => {
    methods.push(init.method);
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    if (init.method !== 'POST') throw Error('Unexpected network method');
    const m = JSON.parse(init.body); rpc.push(m.method);
    if (m.method === 'initialize') return response(m.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    if (m.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (fault) throw Error('Real POST transport failure');
    return response(m.id, toolResult(42));
  });
  vi.stubGlobal('fetch', network);
  const w = createCoreLivenessWatchdog({ pid: 42, port: 12345 }, { onState: s => states.push(s), onFailure: failures });
  return { w, rpc, methods, states, failures, connects, network, fault: () => { fault = true; } };
}
describe('real SDK with local unsupported optional GET', () => {
  it('connects and keeps one session beyond multiple old 300/330/360s cycles', async () => {
    const f = virtualSdk(); f.w.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (const ms of [300000, 30000, 30000, 360000, 360000]) {
        await vi.advanceTimersByTimeAsync(ms);
        expect(f.w.state().status).toBe('ready'); expect(f.w.state().failures).toBe(0);
      }
      expect(f.w.state().probes).toBe(37); expect(f.connects).toHaveBeenCalledTimes(1);
      expect(f.rpc.filter(m => m === 'initialize')).toHaveLength(1); expect(f.rpc.filter(m => m === 'tools/call')).toHaveLength(37);
      expect(f.rpc.filter(m => m === 'notifications/initialized')).toHaveLength(1);
      expect(f.methods).not.toContain('GET'); expect(f.states.some(s => s.status === 'degraded')).toBe(false); expect(f.failures).not.toHaveBeenCalled();
    } finally { await f.w.stop(); }
    expect(f.methods.filter(m => m === 'DELETE')).toHaveLength(1);
  });
  it('actual Client.close still invalidates the private connection', async () => {
    const f = virtualSdk(); f.w.start();
    try {
      await vi.advanceTimersByTimeAsync(0); expect(f.w.state().status).toBe('ready');
      await f.connects.mock.contexts[0].close();
      await vi.advanceTimersByTimeAsync(30000); expect(f.w.state()).toMatchObject({ status: 'degraded', failures: 1 });
      await vi.advanceTimersByTimeAsync(30000); expect(f.w.state()).toMatchObject({ status: 'ready', failures: 0 }); expect(f.connects).toHaveBeenCalledTimes(2);
    } finally { await f.w.stop(); }
  });
  it('genuine POST errors still fail three times and call onFailure exactly once', async () => {
    const f = virtualSdk(); f.w.start();
    try {
      await vi.advanceTimersByTimeAsync(0); f.fault();
      await vi.advanceTimersByTimeAsync(30000); expect(f.w.state()).toMatchObject({ status: 'degraded', failures: 1 });
      await vi.advanceTimersByTimeAsync(60000); expect(f.w.state()).toMatchObject({ status: 'failed', failures: 3 }); expect(f.failures).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(360000); expect(f.failures).toHaveBeenCalledTimes(1);
      expect(f.rpc.filter(m => m === 'tools/call')).toHaveLength(4); // One healthy + three failures, no replay.
    } finally { await f.w.stop(); }
  });
});

describe('real loopback POST failure after remediated SDK connection', () => {
  it('does not hide genuine HTTP failure or replay the failed operation', async () => {
    const requests = [], states = [], failed = vi.fn();
    let callPosts = 0;
    const server = createServer(async (req, res) => {
      requests.push(req.method);
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      let raw = ''; for await (const b of req) raw += b; const m = JSON.parse(raw);
      if (m.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      if (m.method === 'tools/call') { callPosts++; res.writeHead(503).end('isolated failure'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'negative-private' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'negative', version: '1' } } }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const w = createCoreLivenessWatchdog({ pid: 42, port: server.address().port }, { intervalMs: 30, timeoutMs: 1000, onState: s => states.push(s), onFailure: failed });
    try {
      w.start(); const deadline = Date.now() + 4000;
      while (!failed.mock.calls.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      expect(failed).toHaveBeenCalledTimes(1); expect(w.state()).toMatchObject({ status: 'failed', failures: 3, probes: 3 });
      expect(states.filter(s => s.status === 'degraded').map(s => s.failures)).toEqual([1, 2]); expect(requests).not.toContain('GET');
    } finally { await w.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
    expect(callPosts).toBe(3); // One network operation per failed probe, no SDK replay.
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(3);
  });
});
