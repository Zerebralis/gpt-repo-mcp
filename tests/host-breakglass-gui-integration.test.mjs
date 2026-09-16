/* global process, setTimeout, URL, fetch, AbortSignal */
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = resolve('.');
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function eventually(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(50);
  }
  throw new Error('Fixture deadline exceeded', { cause: last });
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function fixture(mode, guiPortOverride) {
  const root = await mkdtemp(join(tmpdir(), 'breakglass-gui-domain-'));
  const corePort = await freePort();
  const guiPort = guiPortOverride ?? await freePort();
  const state = join(root, 'state');
  await mkdir(state);
  await mkdir(join(root, 'scripts'));
  const configPath = join(root, 'config.json');
  const runtimePath = join(root, 'gui.mjs');
  const crashPath = join(root, 'crash-gui');
  const identitiesPath = join(root, 'identities.json');
  const coreEntry = join(root, 'core.mjs');
  const tunnelEntry = join(root, 'fake-tunnel.mjs');
  await writeFile(configPath, JSON.stringify({
    enabled: true, roots: [{ id: 'fixture', root, read: true, write: true, execute: true }],
    computer_use: { enabled: true, server_url: `http://127.0.0.1:${guiPort}/mcp` },
    audit_path: join(root, 'audit.jsonl')
  }));
  await writeFile(join(state, 'host.env'), [
    'CONTROL_PLANE_TUNNEL_ID=tunnel_isolated_fixture', 'CONTROL_PLANE_API_KEY=isolated-fixture',
    `GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN=${process.execPath}`,
    `GPT_HOST_BREAKGLASS_CONFIG=${configPath}`, `GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY=${runtimePath}`
  ].join('\n'));
  if (mode !== 'missing') await writeFile(runtimePath, `
    import {createServer} from 'node:http';
    import {existsSync} from 'node:fs';
    export function startComputerUseHttpServer() {
      ${mode === 'error' ? "throw new Error('isolated startup failure');" : ''}
      const http=createServer(async (req,res)=>{
        if(req.method==='GET'){res.writeHead(405);res.end();return;}
        let raw=''; for await(const chunk of req) raw+=chunk;
        const msg=JSON.parse(raw || '{}');
        if(msg.method==='initialize'){
          res.writeHead(200,{'content-type':'application/json'});
          res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'isolated-gui',version:'1'}}}));
        }else if(msg.method==='tools/list'){
          res.writeHead(200,{'content-type':'application/json'});
          res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[{name:'screenshot',inputSchema:{type:'object'}}]}}));
        }else{res.writeHead(202);res.end();}
      });
      const timer=setInterval(()=>{if(existsSync(${JSON.stringify(crashPath)}))process.exit(23)},20);
      ${mode === 'timeout' ? '' : "http.listen(Number(process.env.COMPUTER_USE_HTTP_PORT),process.env.COMPUTER_USE_HTTP_HOST);"}
      return {http, close:async()=>{clearInterval(timer);await new Promise(r=>http.close(r))}};
    }
  `);
  // Isolated launcher uses the real native Core, plus an inert tunnel stand-in.
  // IPC disconnect handlers ensure fixture descendants are cleaned up on Windows.
  await writeFile(coreEntry, `
    process.once('disconnect',()=>{process.emit('SIGTERM');setTimeout(()=>process.exit(0),500).unref()});
    await import(${JSON.stringify(pathToFileURL(join(repo, 'src/host-breakglass/server.ts')).href)});
  `);
  await writeFile(tunnelEntry, "process.once('disconnect',()=>process.exit(0));setInterval(()=>{},1000);");
  await writeFile(join(root, 'scripts/connect-host-breakglass-openai.mjs'), `
    import {fork} from 'node:child_process';
    import {writeFile,appendFile} from 'node:fs/promises';
    const core=fork(${JSON.stringify(coreEntry)},[],{cwd:${JSON.stringify(repo)},execArgv:['--import',${JSON.stringify(pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href)}],env:{...process.env,GPT_HOST_BREAKGLASS_PORT:'${corePort}',GPT_HOST_BREAKGLASS_HOST:'127.0.0.1'},stdio:['ignore','ignore','ignore','ipc']});
    const tunnel=fork(${JSON.stringify(tunnelEntry)},[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
    await appendFile(${JSON.stringify(join(root, 'connector-starts'))},'start\\n');
    await writeFile(${JSON.stringify(identitiesPath)},JSON.stringify({connector:process.pid,core:core.pid,tunnel:tunnel.pid}));
    process.on('SIGTERM',()=>{core.disconnect();tunnel.disconnect();process.exit(0)});
  `);
  const supervisorEntry = join(root, 'supervisor-entry.mjs');
  await writeFile(supervisorEntry, `
    process.on('message',m=>{if(m==='stop')process.emit('SIGTERM')});
    await import(${JSON.stringify(pathToFileURL(join(repo, 'scripts/host-breakglass-supervisor.mjs')).href)});
  `);
  const supervisor = fork(supervisorEntry, [], {
    cwd: root, execArgv: [], env: { ...process.env, GPT_HOST_BREAKGLASS_REPO_ROOT: root, GPT_HOST_BREAKGLASS_STATE_DIR: state, GPT_HOST_BREAKGLASS_ENV: join(state, 'host.env') },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  let client;
  let job;
  const stop = async () => {
    if (client) {
      if (job) await client.callTool({ name: 'host_process_kill', arguments: { job_id: job } }).catch(() => undefined);
      await client.close(); client = undefined;
    }
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.send('stop');
      await eventually(() => supervisor.exitCode !== null || supervisor.signalCode !== null, 10000);
    }
    await eventually(async () => {
      try { await fetch(`http://127.0.0.1:${corePort}/health`, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; }
    });
  };
  cleanups.push(async () => {
    await stop();
    if (!resolve(root).startsWith(resolve(tmpdir()) + '\\breakglass-gui-domain-') && !resolve(root).startsWith(resolve(tmpdir()) + '/breakglass-gui-domain-')) throw new Error('Unexpected fixture cleanup path');
    await rm(root, { recursive: true, force: true });
  });
  await eventually(async () => (await fetch(`http://127.0.0.1:${corePort}/health`, { signal: AbortSignal.timeout(300) })).ok);
  client = new Client({ name: 'gui-domain-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${corePort}/mcp`)));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse(result.content[0].text).result;
  };
  return {
    root, supervisor, stop, call, guiPort,
    state: async () => (await json(join(state, 'supervisor-state.json'))).gui,
    identities: () => json(identitiesPath),
    crash: () => writeFile(crashPath, 'crash only this fixture GUI'),
    clearCrash: () => rm(crashPath),
    startJob: async () => {
      const view = await call('host_process_start', { executable: process.execPath, args: ['-e', 'setTimeout(()=>{},120000)'], cwd: root });
      job = view.job_id; return view;
    }
  };
}

describe('real supervisor GUI failure isolation (no production processes)', () => {
  it.each(['missing', 'error', 'timeout'])('starts native Core despite GUI %s', async (mode) => {
    const f = await fixture(mode);
    const before = await f.identities();
    expect((await f.call('host_system_info')).pid).toBe(before.core);
    await eventually(async () => ['unavailable', 'degraded'].includes((await f.state()).status), 18000);
    expect(await f.identities()).toEqual(before);
    expect((await f.call('host_system_info')).pid).toBe(before.core);
    expect(await readFile(join(f.root, 'connector-starts'), 'utf8')).toBe('start\n');
  }, 35000);

  it('preserves Core, connector, tunnel and a managed job across GUI crash', async () => {
    const f = await fixture('ready');
    await eventually(async () => (await f.state()).status === 'ready');
    const before = await f.identities();
    const job = await f.startJob();
    expect((await f.call('host_computer_use_catalog')).tools).toHaveLength(1);
    await f.crash();
    await eventually(async () => (await f.state()).reason === 'backend_exited');
    await f.clearCrash();
    await eventually(async () => (await f.state()).status === 'ready');
    expect((await f.call('host_system_info')).pid).toBe(before.core);
    expect(await f.call('host_process_output', { job_id: job.job_id })).toMatchObject({ job_id: job.job_id, pid: job.pid, status: 'running' });
    expect(await f.identities()).toEqual(before);
    expect(await readFile(join(f.root, 'connector-starts'), 'utf8')).toBe('start\n');
    // A stale downstream session may fail once; the next caller can reconnect without replay.
    try { await f.call('host_computer_use_catalog'); } catch { /* failed old connection discarded */ }
    expect((await f.call('host_computer_use_catalog')).tools).toHaveLength(1);
    await f.stop();
  }, 30000);

  it('does not adopt or terminate a foreign listener even when it responds HTTP 200', async () => {
    const foreign = createServer((_req, res) => { res.writeHead(200); res.end('foreign'); });
    await new Promise((done) => foreign.listen(0, '127.0.0.1', done));
    cleanups.push(() => new Promise((done) => foreign.close(done)));
    const port = foreign.address().port;
    const f = await fixture('ready', port);
    await eventually(async () => (await f.state()).reason === 'retry_budget_exhausted', 15000);
    expect((await f.state()).status).not.toBe('ready');
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('foreign');
    expect((await f.call('host_system_info')).pid).toBe((await f.identities()).core);
  }, 30000);
});
