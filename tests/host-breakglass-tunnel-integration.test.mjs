/* global process, setTimeout, fetch, URL */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runConnector } from '../scripts/connect-host-breakglass-openai.mjs';
import { spawnTunnelOwner } from '../scripts/host-breakglass-tunnel-owner.mjs';
import { createReadinessWatchdog } from '../scripts/tunnel-readiness-watchdog.mjs';
import { createGuiRuntime, computerUseLaunchSpec } from '../scripts/host-breakglass-gui-runtime.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) {
    if (await check())
        return;
    await delay(30);
} throw Error('Isolated integration deadline exceeded'); }
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
function identity(pid) { return execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Write($p.StartTime.ToFileTimeUtc().ToString())`], { encoding: 'utf8', windowsHide: true }).trim(); }
const repo = resolve('.');
describe.skipIf(process.platform !== 'win32')('actual connector + built Core + independent GUI, private Windows jobs', () => {
    it('preserves Core, GUI, job identity/output and sessions through root exit, stale poll and later slow recovery without replay', async () => {
        const root = await mkdtemp(join(tmpdir(), 'breakglass-tunnel-integration-'));
        const state = join(root, 'state');
        await mkdir(state);
        const port = await freePort(), guiPort = await freePort();
        const mode = join(root, 'mode');
        await writeFile(mode, 'healthy');
        const guiEntry = join(root, 'gui.mjs'), tunnelEntry = join(root, 'tunnel.mjs');
        await writeFile(guiEntry, `
      import {createServer} from 'node:http';
      export function startComputerUseHttpServer(){
        const http=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const m=JSON.parse(raw||'{}');
          if(m.method==='initialize'||m.method==='tools/list'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'isolated',version:'1'}}:{tools:[]}}));}
          else{res.writeHead(req.method==='GET'?405:202);res.end();}});
        http.listen(Number(process.env.COMPUTER_USE_HTTP_PORT),process.env.COMPUTER_USE_HTTP_HOST);
        return {http,close:()=>new Promise(r=>http.close(r))};}
    `);
        await writeFile(tunnelEntry, `
      import {createServer} from 'node:http';import {readFileSync,writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
      spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
      const mode=()=>readFileSync(process.env.TEST_MODE,'utf8');
      const s=createServer((req,res)=>{const m=mode();if(req.url==='/readyz'){res.writeHead(m==='unready'?503:200);res.end();}
        else{res.end('commands_poll_last_successful_timestamp_seconds '+(m==='stale'?Date.now()/1000-181:Date.now()/1000));}});
      s.listen(0,'127.0.0.1',()=>{writeFileSync(process.env.HEALTH_URL_FILE,'http://127.0.0.1:'+s.address().port);writeFileSync(process.env.PID_FILE,String(process.pid));});
      setInterval(()=>{if(mode()==='exit'){writeFileSync(process.env.TEST_MODE,'healthy');process.exit(23);}},20);
    `);
        const config = { enabled: true, roots: [{ id: 'fixture', root, read: true, write: true, execute: true }], computer_use: { enabled: true, server_url: `http://127.0.0.1:${guiPort}/mcp` }, audit_path: join(root, 'audit.jsonl') };
        const configPath = join(root, 'config.json');
        await writeFile(configPath, JSON.stringify(config));
        const envPath = join(root, 'host.env');
        await writeFile(envPath, '# isolated\n');
        const env = { ...process.env, GPT_HOST_BREAKGLASS_ENV: envPath, GPT_HOST_BREAKGLASS_STATE_DIR: state, GPT_HOST_BREAKGLASS_STATE_PATH: join(state, 'connector-state.json'), GPT_HOST_BREAKGLASS_CONFIG: configPath, GPT_HOST_BREAKGLASS_PORT: String(port), CONTROL_PLANE_TUNNEL_ID: 'tunnel_isolated_fixture', CONTROL_PLANE_API_KEY: 'isolated-fixture', GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY: guiEntry };
        const gui = createGuiRuntime(computerUseLaunchSpec(config, env, repo, state));
        const exits = [], owners = [];
        let connector, client, job;
        const connect = async () => { const c = new Client({ name: 'tunnel-continuity-test', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))); return c; };
        const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); expect(r.isError).not.toBe(true); return JSON.parse(r.content[0].text).result; };
        try {
            gui.start();
            await until(() => gui.state().status === 'ready');
            connector = await runConnector({ env, cwd: repo, exit: code => exits.push(code), tunnelOptions: {
                    backoffMs: [150, 200, 15000, 30000, 60000],
                    spawnOwner: spec => { const owner = spawnTunnelOwner({ ...spec, executable: process.execPath, args: [tunnelEntry], env: { ...spec.env, TEST_MODE: mode } }); owners.push(owner); return owner; },
                    createWatchdog: options => createReadinessWatchdog({ ...options, intervalMs: 50 })
                } });
            // Same watchdog logic, short interval only for this isolated integration run.
            await until(() => connector.tunnel.state().ready);
            const original = { core: connector.server.pid, coreCreation: identity(connector.server.pid), gui: gui.state(), guiCreation: identity(gui.state().pid), connector: process.pid, connectorCreation: identity(process.pid) };
            client = await connect();
            job = await call('host_process_start', { executable: process.execPath, args: ['-e', "console.log('one-start');setInterval(()=>console.log('heartbeat'),100)"], cwd: root });
            const jobCreation = identity(job.pid);
            const verify = async () => {
                expect(connector.server.pid).toBe(original.core);
                expect(identity(original.core)).toBe(original.coreCreation);
                expect(gui.state()).toEqual(original.gui);
                expect(identity(original.gui.pid)).toBe(original.guiCreation);
                expect(process.pid).toBe(original.connector);
                expect(identity(process.pid)).toBe(original.connectorCreation);
                expect(identity(job.pid)).toBe(jobCreation);
                expect(exits).toEqual([]);
                const output = await call('host_process_output', { job_id: job.job_id });
                expect(output).toMatchObject({ job_id: job.job_id, pid: job.pid, status: 'running' });
                expect(JSON.stringify(output)).toContain('heartbeat');
                expect((JSON.stringify(output).match(/one-start/g) || [])).toHaveLength(1);
                expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
                await call('host_system_info');
            };
            const first = connector.tunnel.state().generation;
            await writeFile(mode, 'exit');
            await until(() => connector.tunnel.state().ready && connector.tunnel.state().generation !== first);
            await verify();
            const second = connector.tunnel.state().generation;
            await writeFile(mode, 'stale');
            await until(() => connector.tunnel.state().status !== 'ready', 45000);
            await writeFile(mode, 'healthy');
            await until(() => connector.tunnel.state().ready && connector.tunnel.state().generation !== second);
            await verify();
            await writeFile(mode, 'unready');
            await until(() => connector.tunnel.state().recovery === 'slow', 45000);
            await client.close();
            client = await connect(); // A new MCP session addresses the same job; no operation replay.
            await verify();
            expect(owners).toHaveLength(3);
            expect(owners.every(o => o.state().confirmed)).toBe(true);
            await connector.publisher.flush();
            const published = JSON.parse(await readFile(join(state, 'connector-state.json'), 'utf8'));
            expect(published).toMatchObject({ ready: false, status:'degraded', recovery:'slow', retry_in_ms:15000, attempts: 3 });
            await expect(readFile(join(state, 'openai-tunnel-health.url'))).rejects.toMatchObject({ code: 'ENOENT' });
            await writeFile(mode,'healthy');
            await until(()=>connector.tunnel.state().ready&&connector.tunnel.state().attempts===4);
            await verify();
            expect(owners).toHaveLength(4);
            expect(owners.slice(0,3).every(o=>o.state().confirmed)).toBe(true);
            await connector.publisher.flush();
            expect(JSON.parse(await readFile(join(state,'connector-state.json'),'utf8'))).toMatchObject({ready:true,status:'ready',attempts:4});
            const audit = await readFile(config.audit_path, 'utf8');
            expect(audit).toContain('host_process_start');
            expect(audit).toContain('host_system_info');
        }
        finally {
            if (job && client)
                await client.callTool({ name: 'host_process_kill', arguments: { job_id: job.job_id } }).catch(() => { });
            await client?.close();
            await connector?.shutdown(0);
            await gui.stop();
        }
    }, 120000);
});
