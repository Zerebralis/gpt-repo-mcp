/* global process, console, fetch, setTimeout, clearTimeout, AbortController, AbortSignal */
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTunnelRuntime, createTunnelStatePublisher } from './host-breakglass-tunnel-runtime.mjs';
import { createCoreLivenessWatchdog } from './host-breakglass-core-liveness.mjs';
import { expectedHostPolicy } from './host-breakglass-config-watch.mjs';
// Tests execute this same entry/lifecycle with only the tunnel OS boundary injected.
export async function runConnector(options = {}) {
    const env = options.env ?? process.env;
    const repoRoot = options.cwd ?? process.cwd();
    const stateDir = env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(env.LOCALAPPDATA ?? repoRoot, 'gpt-repo-host-breakglass');
    const statePath = env.GPT_HOST_BREAKGLASS_STATE_PATH ?? join(stateDir, 'connector-state.json');
    const abort = new AbortController();
    let stopping = false, server, tunnel, publisher, liveness, shutdownPromise;
    const exit = options.exit ?? (code => process.exit(code));
    const onSignal = () => { void shutdown(0); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    async function shutdown(code) {
        if (stopping)
            return shutdownPromise;
        stopping = true;
        abort.abort();
        shutdownPromise = (async () => {
            await liveness?.stop();
            const clean = await tunnel?.stop();
            await publisher?.publish({ status: clean === false ? 'cleanup_unconfirmed' : 'stopped', ready: false, generation: tunnel?.state().generation ?? null }).catch(() => { });
            if (server && server.exitCode === null && server.signalCode === null) {
                server.kill('SIGTERM');
                await new Promise(done => {
                    const timer = setTimeout(done, 1200);
                    server.once('exit', () => { clearTimeout(timer); done(); });
                });
                if (server.exitCode === null && server.signalCode === null)
                    server.kill('SIGKILL');
            }
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
            exit(code);
        })();
        return shutdownPromise;
    }
    try {
        await loadEnv(env.GPT_HOST_BREAKGLASS_ENV ?? join(stateDir, 'host.env'), env);
        if (stopping)
            return { shutdown };
        const configPath = resolve(repoRoot, env.GPT_HOST_BREAKGLASS_CONFIG ?? 'config.host-breakglass.local.json');
        const port = integer(env.GPT_HOST_BREAKGLASS_PORT ?? '8797', 'port', 1, 65535);
        const tunnelId = required(env, 'CONTROL_PLANE_TUNNEL_ID');
        required(env, 'CONTROL_PLANE_API_KEY');
        if (!/^tunnel_[a-zA-Z0-9_-]{8,}$/.test(tunnelId))
            throw Error('Invalid tunnel ID format');
        const pollStartupTimeoutMs = integer(env.GPT_HOST_BREAKGLASS_TUNNEL_POLL_STARTUP_TIMEOUT_MS ?? '90000', 'poll startup timeout', 10000, 600000);
        const pollStaleMs = integer(env.GPT_HOST_BREAKGLASS_TUNNEL_POLL_STALE_MS ?? '180000', 'poll stale limit', 60000, 900000);
        await access(configPath, constants.R_OK);
        const expectedPolicy = await expectedPolicyFromConfig(configPath);
        await access(join(repoRoot, 'dist/host-breakglass/server.js'), constants.R_OK);
        await mkdir(stateDir, { recursive: true });
        if (stopping)
            return { shutdown };
        publisher = createTunnelStatePublisher(stateDir, statePath, { local_port: port, mode: 'openai-secure-tunnel' });
        await publisher.publish({ status: 'starting', ready: false, generation: null, attempts: 0 });
        if (stopping)
            return { shutdown };
        server = spawn(process.execPath, ['dist/host-breakglass/server.js'], { cwd: repoRoot, env: { ...minimalEnv(env), GPT_HOST_BREAKGLASS_CONFIG: configPath, GPT_HOST_BREAKGLASS_HOST: '127.0.0.1', GPT_HOST_BREAKGLASS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        for (const stream of [server.stdout, server.stderr])
            pipe(stream, 'host-breakglass');
        server.once('error', () => { if (!stopping)
            void shutdown(1); });
        server.once('exit', code => { if (!stopping)
            void shutdown(code ?? 1); });
        await waitForHost(server, port, abort.signal, expectedPolicy);
        if (stopping)
            return { shutdown };
        tunnel = createTunnelRuntime({
            executable: env.GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN?.trim() || 'C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe',
            cwd: repoRoot, stateDir, pollStartupTimeoutMs, pollStaleMs,
            env: { ...minimalEnv(env), CONTROL_PLANE_TUNNEL_ID: tunnelId, CONTROL_PLANE_API_KEY: env.CONTROL_PLANE_API_KEY,
                ...(env.CONTROL_PLANE_ORGANIZATION_ID ? { CONTROL_PLANE_ORGANIZATION_ID: env.CONTROL_PLANE_ORGANIZATION_ID } : {}),
                MCP_SERVER_URL: `http://127.0.0.1:${port}/mcp`, MCP_STARTUP_WAIT_TIMEOUT: '10s', LOG_LEVEL: env.GPT_HOST_BREAKGLASS_TUNNEL_LOG_LEVEL ?? 'info', LOG_FORMAT: 'json' }
        }, { ...options.tunnelOptions, onState: state => {
                if (stopping)
                    return;
                console.log(`[tunnel] ${state.status} attempt=${state.attempts} reason=${state.reason ?? 'none'}`);
                void publisher.publish(state).catch(() => console.error('[tunnel] status publication failed'));
                options.onTunnelState?.(state);
            } });
        tunnel.start();
        liveness = createCoreLivenessWatchdog({ pid: server.pid, port }, {
            ...options.coreLivenessOptions,
            onFailure: () => { if (!stopping) void shutdown(1); },
            onState: state => {
                if (stopping) return;
                if (state.status === 'degraded' || state.status === 'failed')
                    console.error(`[core-liveness] ${state.status} consecutive_failures=${state.failures}`);
                options.onCoreLivenessState?.(state);
            }
        });
        liveness.start();
        return { shutdown, tunnel, server, publisher, liveness };
    }
    catch (error) {
        if (!stopping)
            console.error(`Connector startup failed: ${sanitize(error.message)}`);
        await shutdown(1);
        return { shutdown };
    }
}
async function waitForHost(child, port, signal, expectedPolicy) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !signal.aborted) {
        if (child.exitCode !== null || child.signalCode !== null)
            throw Error('Core exited before readiness');
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) });
            if (r.ok) {
                const health = await r.json();
                if (hostHealthMatchesExpectedPolicy(health, expectedPolicy))
                    return;
            }
        }
        catch { /* bounded startup */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw Error('Core readiness deadline exceeded');
}
export async function expectedPolicyFromConfig(configPath) {
    const raw = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
    return expectedHostPolicy(raw);
}
export function hostHealthMatchesExpectedPolicy(health, expectedPolicy) {
    return health?.ok === true &&
        health?.mode === expectedPolicy.mode &&
        health?.full_host_access === expectedPolicy.full_host_access;
}
async function loadEnv(path, env) {
    const raw = await readFile(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('='))
            continue;
        const [key, ...parts] = t.split('=');
        if (!key || env[key] !== undefined)
            continue;
        const v = parts.join('=').trim();
        env[key] = ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;
    }
}
function integer(raw, name, min, max) { const n = Number(raw); if (!Number.isInteger(n) || n < min || n > max)
    throw Error(`Invalid ${name}`); return n; }
function required(env, name) { const v = env[name]?.trim(); if (!v)
    throw Error(`Missing ${name}`); return v; }
function minimalEnv(env) { const out = {}; for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'])
    if (env[k] !== undefined)
        out[k] = env[k]; return out; }
function sanitize(s) { return String(s).replace(/https?:\/\/\S+/gi, '[URL]').replace(/tunnel_[a-zA-Z0-9_-]+/g, 'tunnel_[REDACTED]').replace(/(?:sk-|sess-|key-)[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]'); }
function pipe(stream, label) { let b = ''; stream.on('data', chunk => { b += chunk.toString(); const lines = b.split(/\r?\n/); b = lines.pop() ?? ''; for (const line of lines)
    if (line.trim())
        console.log(`[${label}] ${sanitize(line)}`); }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    await runConnector();
