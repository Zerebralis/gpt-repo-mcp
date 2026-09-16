/* global process, setTimeout, clearTimeout, fetch, AbortSignal, URL, console */
// Explicit opt-in real-runtime compatibility gate; no production credentials/configuration.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { spawnTunnelOwner } from '../scripts/host-breakglass-tunnel-owner.mjs';
import { createTunnelRuntime } from '../scripts/host-breakglass-tunnel-runtime.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (value, message) => { if (!value)
    throw Error(message); };
const event = (owner, name, timeout = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { owner.events.off(name, done); reject(Error('Timeout: ' + name)); }, timeout);
    const done = v => { clearTimeout(timer); resolve(v); };
    owner.events.once(name, done);
});
const snapshot = () => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('node.exe','cmd.exe','codex.exe','tunnel-client.exe')} | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert(r.status === 0, 'CIM snapshot failed');
    return JSON.parse(r.stdout);
};
const root = await mkdtemp(join(tmpdir(), 'breakglass-tunnel-ownership-'));
const before = snapshot();
const controlCalls = [];
const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req)
        raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp') {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        if (!raw.trim()) {
            res.writeHead(202).end();
            return;
        }
        let rpc;
        try {
            rpc = JSON.parse(raw);
        }
        catch {
            res.writeHead(400).end('{}');
            return;
        }
        if (rpc.id === undefined) {
            res.writeHead(202).end();
            return;
        }
        const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'isolated-ownership-gate', version: '1' } } : rpc.method === 'tools/list' ? { tools: [] } : {};
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
        return;
    }
    controlCalls.push(req.url);
    if (req.url?.startsWith('/.well-known/')) {
        res.writeHead(404).end('{}');
        return;
    }
    if (req.url?.includes('/poll')) {
        await sleep(250);
        res.end(JSON.stringify({ commands: [] }));
        return;
    }
    res.end('{}');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let owner, runtime;
const report = { runtime: 'v0.0.14', real_control_plane: 'NOT_TESTED_ISOLATED_LOCAL_STUB', root };
try {
    const env = {};
    for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'])
        if (process.env[k] !== undefined)
            env[k] = process.env[k];
    await mkdir(join(root, 'codex-home'));
    Object.assign(env, { CODEX_HOME: join(root, 'codex-home'), CONTROL_PLANE_TUNNEL_ID: 'tunnel_00000000000000000000000000000000', CONTROL_PLANE_API_KEY: 'isolated-not-a-real-key', CONTROL_PLANE_BASE_URL: `http://127.0.0.1:${server.address().port}`, MCP_SERVER_URL: `http://127.0.0.1:${server.address().port}/mcp`, HEALTH_LISTEN_ADDR: '127.0.0.1:0', HEALTH_URL_FILE: join(root, 'health.url'), PID_FILE: join(root, 'tunnel.pid'), LOG_LEVEL: 'error', LOG_FORMAT: 'json' });
    owner = spawnTunnelOwner({ generation: randomUUID(), executable: 'C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe', args: ['run'], cwd: root, stdout: join(root, 'stdout.log'), stderr: join(root, 'stderr.log'), env });
    const spawned = await event(owner, 'spawned');
    report.spawned = spawned;
    let health;
    for (let i = 0; i < 100; i++) {
        try {
            health = (await readFile(env.HEALTH_URL_FILE, 'utf8')).trim();
            break;
        }
        catch {
            await sleep(100);
        }
    }
    assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(health ?? ''), 'No private health URL');
    for (let i = 0; i < 100; i++) {
        const ready = await fetch(health + '/readyz', { signal: AbortSignal.timeout(3000) });
        report.readyz = ready.status;
        report.ready_body = await ready.text();
        if (report.readyz === 200)
            break;
        await sleep(100);
    }
    assert(report.readyz === 200, 'Real runtime readiness failed');
    report.listener_owned = await owner.verifyListener(Number(new URL(health).port));
    assert(report.listener_owned, 'Own health listener not confirmed');
    report.foreign_listener_rejected = !(await owner.verifyListener(server.address().port));
    assert(report.foreign_listener_rejected, 'Foreign listener adopted');
    let members, active;
    for (let i = 0; i < 30; i++) {
        const pending = event(owner, 'members', 3000);
        owner.send('members');
        members = (await pending).members;
        active = snapshot().filter(p => members.includes(p.ProcessId));
        if (['cmd.exe', 'node.exe', 'codex.exe'].every(n => active.some(p => p.Name === n)))
            break;
        await sleep(200);
    }
    assert(['cmd.exe', 'node.exe', 'codex.exe'].every(n => active.some(p => p.Name === n)), 'Real sidecar chain incomplete');
    report.members = active;
    assert(members.includes(spawned.pid), 'Root absent from Job Object');
    assert(!before.some(p => members.includes(p.ProcessId)), 'Foreign process in Job Object');
    const exited = event(owner, 'root_exit', 5000);
    owner.send('terminate-root');
    report.after_root_exit = await exited;
    report.cleanup_confirmed = await owner.stop();
    assert(report.cleanup_confirmed, 'Cleanup unconfirmed');
    const after = snapshot();
    report.survivors = active.filter(p => after.some(a => a.ProcessId === p.ProcessId && a.CreationDate === p.CreationDate));
    assert(report.survivors.length === 0, 'Owned survivor');
    const protectedBefore = before.filter(p => p.Name === 'tunnel-client.exe' || p.Name === 'codex.exe');
    report.foreign_unchanged = protectedBefore.every(p => after.some(a => a.ProcessId === p.ProcessId && a.CreationDate === p.CreationDate));
    assert(report.foreign_unchanged, 'Foreign identity changed');
    const generations = [], runtimeOwners = [];
    runtime = createTunnelRuntime({ executable: 'C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe', cwd: root, stateDir: root, env, pollStartupTimeoutMs: 10000, pollStaleMs: 180000 }, { spawnOwner: spec => { const owned = spawnTunnelOwner(spec); runtimeOwners.push(owned); return owned; }, onState: s => generations.push(s) });
    runtime.start();
    const waitReady = async (attempt) => { for (let i = 0; i < 300; i++) {
        if (runtime.state().ready && runtime.state().attempts === attempt)
            return;
        await sleep(100);
    } throw Error('Real generation did not reach ready: ' + JSON.stringify(runtime.state())); };
    await waitReady(1);
    runtimeOwners[0].send('terminate-root');
    await waitReady(2);
    report.runtime_generations = generations;
    report.runtime_cleanup = await runtime.stop();
    assert(report.runtime_cleanup, 'Real runtime controller cleanup unconfirmed');
    assert(runtimeOwners.every(o => o.state().confirmed), 'Generation owner not confirmed empty');
    const finalSnapshot = snapshot();
    assert(!finalSnapshot.some(p => !before.some(b => b.ProcessId === p.ProcessId && b.CreationDate === p.CreationDate) && generations.some(g => g.pid === p.ProcessId)), 'Runtime root survived');
    assert(protectedBefore.every(p => finalSnapshot.some(a => a.ProcessId === p.ProcessId && a.CreationDate === p.CreationDate)), 'Foreign identity changed during controller smoke');
    report.local_control_plane_requests = controlCalls.length;
    report.pass = true;
}
catch (e) {
    report.pass = false;
    report.error = e.message;
    process.exitCode = 1;
}
finally {
    if (runtime)
        report.runtime_final_cleanup = await runtime.stop();
    report.control_calls = controlCalls.slice(-10);
    if (owner && !owner.state().exited)
        report.final_cleanup = await owner.stop();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
