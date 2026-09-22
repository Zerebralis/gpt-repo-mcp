/* global process, fetch, setTimeout */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createCoreLivenessWatchdog } from '../scripts/host-breakglass-core-liveness.mjs';

// Keep the real connector, child spawn, health gate and shutdown. Only the tunnel
// boundary is inert: these tests never use installed tunnel binaries/credentials.
const tunnelStop = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../scripts/host-breakglass-tunnel-runtime.mjs', async original => ({
  ...await original(), createTunnelRuntime: () => ({ start() {}, stop: tunnelStop, state: () => ({ generation: 'isolated' }) })
}));
import { runConnector } from '../scripts/connect-host-breakglass-openai.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await sleep(10); }
  throw Error('Isolated liveness test deadline exceeded');
}
async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  expect([3107, 8797]).not.toContain(port); return port;
}
async function close(server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }

describe('real private MCP probe transport', () => {
  it('reuses one session, renews only after invalidation and deletes its own sessions on close', async () => {
    const sessions = new Set(), methods = [], calledSessions = [], deleted = [], failures = [];
    let initializes = 0, invalidate = false;
    const server = createServer(async (req, res) => {
      const id = req.headers['mcp-session-id'];
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return; }
      if (req.method === 'DELETE') { deleted.push(id); sessions.delete(id); res.writeHead(200).end(); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      const m = JSON.parse(body); methods.push(m.method);
      if (m.method === 'initialize') {
        const session = `private-${++initializes}`; sessions.add(session);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'isolated', version: '1' } } })); return;
      }
      if (!m.id && m.id !== 0) { res.writeHead(202).end(); return; }
      if (invalidate || !sessions.has(id)) { invalidate = false; sessions.delete(id); res.writeHead(400).end('Invalid session'); return; }
      expect(m.method).toBe('tools/call'); expect(m.params).toEqual({ name: 'host_system_info', arguments: {} });
      calledSessions.push(id);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [
        { type: 'text', text: JSON.stringify({ ok: true, result: { pid: 42 } }) },
        { type: 'text', text: JSON.stringify({ audit: { ok: false, code: 'HOST_BREAKGLASS_AUDIT_ERROR' } }) }
      ] } }) + '\n\n');
    });
    const port = await listen(server);
    const watchdog = createCoreLivenessWatchdog({ pid: 42, port }, { intervalMs: 50, timeoutMs: 500, onFailure: s => failures.push(s) });
    try {
      watchdog.start(); await until(() => calledSessions.length >= 4);
      expect(initializes).toBe(1); expect(new Set(calledSessions).size).toBe(1);
      expect(watchdog.state().failures).toBe(0);
      invalidate = true; await until(() => initializes === 2 && calledSessions.includes('private-2'));
      await until(() => watchdog.state().status === 'ready');
      expect(watchdog.state().failures).toBe(0); expect(failures).toEqual([]);
      expect(deleted).toContain('private-1');
      expect(methods.every(m => ['initialize', 'notifications/initialized', 'tools/call'].includes(m))).toBe(true);
    } finally { await watchdog.stop(); await close(server); }
    expect(deleted).toContain('private-2'); expect(sessions.size).toBe(0);
  });

  it.each(['initialize', 'notifications/initialized'])('bounds a stalled %s handshake and closes the in-flight request', async stalled => {
    let aborted = false;
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const m = JSON.parse(raw);
      if (m.method === stalled) { res.on('close', () => { aborted = true; }); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'private-stall' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'isolated', version: '1' } } }));
    });
    const port = await listen(server);
    const watchdog = createCoreLivenessWatchdog({ pid: 42, port }, { intervalMs: 5000, timeoutMs: 100 });
    try {
      watchdog.start(); await until(() => watchdog.state().failures === 1);
      await until(() => aborted); expect(watchdog.state().status).toBe('degraded');
    } finally { await watchdog.stop(); await close(server); }
  });
});

describe('existing connector shutdown on confirmed functional loss', () => {
  it.each(['hang', 'wrong-pid'])('health stays 200 but MCP %s causes exactly one shutdown after three failures', async mode => {
    tunnelStop.mockClear();
    const root = await mkdtemp(join(tmpdir(), 'breakglass-core-liveness-'));
    await mkdir(join(root, 'dist/host-breakglass'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'config.json'), '{}');
    await writeFile(join(root, 'host.env'), '# isolated\n');
    await writeFile(join(root, 'dist/host-breakglass/server.js'), `
      import {createServer} from 'node:http';
      createServer(async(req,res)=>{
        if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true,"mode":"safe","full_host_access":false}');return}
        if(req.method==='GET'){res.writeHead(405).end();return}
        if(req.method==='DELETE'){res.writeHead(200).end();return}
        let raw='';for await(const c of req)raw+=c;const m=JSON.parse(raw);
        if(m.method==='notifications/initialized'){res.writeHead(202).end();return}
        if(m.method==='tools/call'&&${JSON.stringify(mode)}==='hang')return;
        const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'isolated',version:'1'}}:{content:[{type:'text',text:JSON.stringify({ok:true,result:{pid:process.pid+1}})}]};
        res.writeHead(200,{'content-type':'application/json','mcp-session-id':'private-test'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
      }).listen(Number(process.env.GPT_HOST_BREAKGLASS_PORT),'127.0.0.1');
    `);
    const reserve = createServer(); const port = await listen(reserve); await close(reserve);
    const env = { ...process.env, GPT_HOST_BREAKGLASS_ENV: join(root, 'host.env'), GPT_HOST_BREAKGLASS_CONFIG: join(root, 'config.json'), GPT_HOST_BREAKGLASS_STATE_DIR: join(root, 'state'), GPT_HOST_BREAKGLASS_STATE_PATH: join(root, 'state/connector-state.json'), GPT_HOST_BREAKGLASS_PORT: String(port), CONTROL_PLANE_TUNNEL_ID: 'tunnel_isolated_liveness', CONTROL_PLANE_API_KEY: 'isolated-test' };
    const exits = [], states = []; let connector;
    try {
      connector = await runConnector({ cwd: root, env, exit: code => exits.push(code), coreLivenessOptions: { intervalMs: 200, timeoutMs: 150 }, onCoreLivenessState: s => states.push(s) });
      expect(connector.server.pid).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      await until(() => states.some(s => s.failures === 2));
      expect(exits).toEqual([]); expect(tunnelStop).not.toHaveBeenCalled();
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      await until(() => exits.length === 1);
      expect(states.filter(s => s.status === 'failed')).toHaveLength(1);
      expect(exits).toEqual([1]); expect(tunnelStop).toHaveBeenCalledTimes(1);
      expect(connector.server.exitCode !== null || connector.server.signalCode !== null).toBe(true);
      await sleep(350); expect(exits).toEqual([1]);
    } finally { await connector?.shutdown(0); }
  });
});
