/* global process, console, fetch, AbortSignal, setTimeout */
// Opt-in Windows compatibility gate. Only new temporary state, ports and own children.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assert = (ok, message) => { if (!ok) throw Error(message); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(probe, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return; await sleep(100); } throw Error('Isolated readiness deadline exceeded'); }
async function freePort() { const s = netServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); assert(![3107, 8797].includes(port), 'Production port refused'); return port; }
function snapshot() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert(r.status === 0, 'CIM inventory unavailable'); return JSON.parse(r.stdout);
}
const source = resolve(process.argv[2] ?? '');
assert(process.argv[2] && process.platform === 'win32', 'Usage on Windows: node scripts/smoke-host-breakglass-release.mjs RELEASE_RUNTIME_DIRECTORY');
const root = await mkdtemp(join(tmpdir(), 'breakglass-release-real-'));
const runtime = join(root, 'runtime');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert(!root.toLowerCase().startsWith(repo.toLowerCase()), 'Smoke must be outside repository');
for (let p = root; ; p = dirname(p)) {
  try { await access(join(p, 'node_modules')); throw Error('Ancestor node_modules exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (dirname(p) === p) break;
}
await cp(source, runtime, { recursive: true, errorOnExist: true, force: false });
const manifestBytes = await readFile(join(runtime, 'release-manifest.json'));
const manifest = JSON.parse(manifestBytes);
for (const f of manifest.files) assert(createHash('sha256').update(await readFile(join(runtime, f.path))).digest('hex') === f.sha256, 'Release file hash mismatch');
const before = snapshot();
const report = { root, release_kind: manifest.kind, manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'), real_control_plane: 'NOT_USED_LOCAL_STUB_ONLY', ancestor_node_modules: false, node_path: 'UNSET' };
const env = {};
for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (process.env[k] !== undefined) env[k] = process.env[k];
let gui, connector, supervisor, session, corePort, guiPort;
const owners = [], ownedPids = [];
const control = createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  report.local_control_requests = (report.local_control_requests ?? 0) + 1;
  res.setHeader('content-type', 'application/json');
  if (req.url.includes('/poll')) { await sleep(100); res.end('{"commands":[]}'); }
  else if (req.url.startsWith('/.well-known/')) res.writeHead(404).end('{}');
  else res.end('{}');
});
async function rpc(method, params = {}) {
  const r = await fetch(`http://127.0.0.1:${corePort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-03-26' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  assert(r.ok, 'MCP HTTP failure'); session ??= r.headers.get('mcp-session-id');
  const text = await r.text(); const result = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(l => l.startsWith('data:')).slice(5) : text);
  assert(!result.error, 'MCP protocol error'); return result.result;
}
try {
  // Actual supervisor entry imports the release GUI bundle. Missing fixture credentials
  // intentionally stop before a remote spawn; no real credential is read or copied.
  const supervisorState = join(root, 'supervisor-state'); await mkdir(supervisorState);
  await writeFile(join(supervisorState, 'host.env'), '# isolated supervisor import gate\n');
  const wrapper = join(root, 'supervisor-entry.mjs');
  await writeFile(wrapper, `process.on('message',m=>{if(m==='stop')process.emit('SIGTERM')});await import(${JSON.stringify(pathToFileURL(join(runtime, 'scripts/host-breakglass-supervisor.mjs')).href)});`);
  supervisor = spawn(process.execPath, [wrapper], { cwd: runtime, env: { ...env, GPT_HOST_BREAKGLASS_STATE_DIR: supervisorState }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  ownedPids.push(supervisor.pid); let supervisorLog = ''; supervisor.stdout.on('data', b => supervisorLog += b); supervisor.stderr.on('data', b => supervisorLog += b);
  await until(async () => { try { return JSON.parse(await readFile(join(supervisorState, 'supervisor-state.json'), 'utf8')).status === 'blocked'; } catch { return false; } });
  assert(!supervisorLog.includes('ERR_MODULE_NOT_FOUND'), 'Supervisor dependency missing');
  report.supervisor_import_start = 'PASS (isolated missing-credential gate)';
  const stopped = once(supervisor, 'exit'); supervisor.send('stop'); await stopped;
  corePort = await freePort(); guiPort = await freePort();
  const state = join(root, 'state'); await mkdir(state);
  await mkdir(join(root, 'codex-home'));
  const configPath = join(root, 'config.json');
  const config = { enabled: true, mode: 'safe', full_host_access: false, roots: [{ id: 'fixture', root, read: true, write: true, execute: true }], audit_path: join(state, 'audit.jsonl'), computer_use: { enabled: true, server_url: `http://127.0.0.1:${guiPort}/mcp` } };
  await writeFile(configPath, JSON.stringify(config)); await writeFile(join(state, 'host.env'), '# isolated connector inputs provided explicitly\n');
  const guiModule = await import(pathToFileURL(join(runtime, 'scripts/host-breakglass-gui-runtime.mjs')).href);
  const launch = { ...env, GPT_HOST_BREAKGLASS_CONFIG: configPath, GPT_HOST_BREAKGLASS_STATE_DIR: state, GPT_HOST_BREAKGLASS_PORT: String(corePort), CONTROL_PLANE_TUNNEL_ID: 'tunnel_00000000000000000000000000000000', CONTROL_PLANE_API_KEY: 'isolated-not-a-real-key' };
  gui = guiModule.createGuiRuntime(guiModule.computerUseLaunchSpec(config, launch, runtime, state), { onChild: child => { ownedPids.push(child.pid); child.stdout.resume(); child.stderr.resume(); } });
  gui.start(); await until(() => gui.state().status === 'ready');
  report.real_gui = { ...gui.state(), handshake: 'PASS', own_listening_ipc: 'PASS' };
  await new Promise(r => control.listen(0, '127.0.0.1', r));
  const { runConnector } = await import(pathToFileURL(join(runtime, 'scripts/connect-host-breakglass-openai.mjs')).href);
  const { spawnTunnelOwner } = await import(pathToFileURL(join(runtime, 'scripts/host-breakglass-tunnel-owner.mjs')).href);
  connector = await runConnector({ cwd: runtime, env: launch, exit: code => { report.connector_exit_code = code; }, tunnelOptions: { spawnOwner: spec => {
    // Only the network boundary is redirected; real installed tunnel, ownership and lifecycle.
    const owner = spawnTunnelOwner({ ...spec, env: { ...spec.env, CONTROL_PLANE_BASE_URL: `http://127.0.0.1:${control.address().port}`, CODEX_HOME: join(root, 'codex-home') } });
    owners.push(owner); ownedPids.push(owner.child.pid); owner.events.on('spawned', m => ownedPids.push(m.pid)); return owner;
  } } });
  ownedPids.push(connector.server.pid);
  await until(() => connector.tunnel.state().ready, 45000);
  const healthResponse = await fetch(`http://127.0.0.1:${corePort}/health`); report.health_http = healthResponse.status; report.health = await healthResponse.json();
  assert(healthResponse.status === 200 && report.health.tool_count === 41, 'Core health/tool contract');
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolated-release-smoke', version: '1' } });
  const tools = await rpc('tools/list'); assert(tools.tools.length === 41, 'MCP tool count');
  report.mcp_tool_count = tools.tools.length;
  const call = await rpc('tools/call', { name: 'host_computer_use_call', arguments: { tool: 'get_display_size', arguments: {} } });
  assert(!call.isError, 'Real GUI observation failed'); report.gui_observation = call;
  report.tunnel = connector.tunnel.state();
  const current = snapshot(); const known = new Set(ownedPids);
  let changed; do { changed = false; for (const p of current) if (known.has(p.ParentProcessId) && !known.has(p.ProcessId)) { known.add(p.ProcessId); changed = true; } } while (changed);
  report.owned_before_cleanup = current.filter(p => known.has(p.ProcessId));
  report.pass = true;
} catch (e) { report.pass = false; report.error = e.message; process.exitCode = 1; }
finally {
  try {
    if (session) await fetch(`http://127.0.0.1:${corePort}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': session }, signal: AbortSignal.timeout(2000) }).catch(() => {});
    await connector?.shutdown(0);
    report.gui_cleanup = await gui?.stop();
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) { const done = once(supervisor, 'exit'); supervisor.send('stop'); await done; }
    report.tunnel_cleanup = owners.every(o => o.state().confirmed && o.state().exited);
    const after = snapshot();
    report.survivors = (report.owned_before_cleanup ?? []).filter(p => after.some(a => a.ProcessId === p.ProcessId && a.CreationDate === p.CreationDate));
    report.foreign_runtime_unchanged = before.filter(p => ['tunnel-client.exe', 'codex.exe'].includes(p.Name)).every(p => after.some(a => a.ProcessId === p.ProcessId && a.CreationDate === p.CreationDate));
    assert(report.gui_cleanup && report.tunnel_cleanup && report.survivors.length === 0 && report.foreign_runtime_unchanged, 'Cleanup/foreign identity gate failed');
    for (const port of [corePort, guiPort].filter(Boolean)) { const s = netServer(); await new Promise((r, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', r); }); await new Promise(r => s.close(r)); }
    report.ports_free_after_cleanup = true;
  } catch (e) { report.pass = false; report.cleanup_error = e.message; process.exitCode = 1; }
  control.closeAllConnections(); if (control.listening) await new Promise(r => control.close(r));
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, error: report.error, cleanup_error: report.cleanup_error, report: join(root, 'result.json') }));
}
