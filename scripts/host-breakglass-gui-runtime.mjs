/* global process, setTimeout, clearTimeout, URL, AbortController */
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const childScript = join(dirname(fileURLToPath(import.meta.url)), 'host-breakglass-gui-child.mjs');

// Policy validation is synchronous and independent of optional runtime availability.
export function computerUseLaunchSpec(config, env, repoRoot, stateDir) {
  if (config?.computer_use?.enabled !== true) return undefined;
  const target = new URL(config.computer_use.server_url ?? 'http://127.0.0.1:3107/mcp');
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)
      || target.pathname.replace(/\/+$/, '') !== '/mcp' || target.username || target.password || target.search || target.hash) {
    throw new Error('Computer-Use target must be an unauthenticated loopback MCP URL.');
  }
  const runtimeEnv = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    if (env[name] !== undefined) runtimeEnv[name] = env[name];
  }
  const bindHost = host === 'localhost' ? '127.0.0.1' : host;
  const port = Number(target.port || 80);
  return {
    entry: resolve(env.GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY?.trim() || 'C:\\Tools\\computer-use-runtime\\node_modules\\@zavora-ai\\computer-use-mcp\\dist\\http.js'),
    cwd: repoRoot,
    url: `http://${bindHost === '::1' ? '[::1]' : bindHost}:${port}/mcp`,
    host: bindHost, port,
    env: {
      ...runtimeEnv,
      COMPUTER_USE_PROFILE: env.GPT_HOST_BREAKGLASS_COMPUTER_USE_PROFILE ?? 'ax',
      COMPUTER_USE_ACTIVE_PROFILE: env.GPT_HOST_BREAKGLASS_COMPUTER_USE_ACTIVE_PROFILE ?? 'ax',
      COMPUTER_USE_HTTP_HOST: bindHost,
      COMPUTER_USE_HTTP_PORT: String(port),
      COMPUTER_USE_FS_ROOTS: (config.roots ?? []).map((entry) => entry.root).join(','),
      COMPUTER_USE_AUDIT_LOG: join(stateDir, 'computer-use-audit.jsonl')
    }
  };
}

export function createGuiRuntime(spec, options = {}) {
  const spawnChild = options.spawn ?? ((generation) => spawn(process.execPath, [childScript, spec.entry, generation], {
    cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
  }));
  const checkEntry = options.checkEntry ?? (() => access(spec.entry));
  const probe = options.probe ?? probeMcp;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const backoff = options.backoffMs ?? [2000, 5000]; // Three attempts per supervisor lifetime, including later crashes.
  const startupMs = options.startupMs ?? 15000;
  const stopMs = options.stopMs ?? 1500;
  let stopped = false;
  let started = false;
  let active;
  let retryTimer;
  let stopPromise;
  let attempts = 0;
  let snapshot = { status: spec ? 'unavailable' : 'disabled', attempts: 0, generation: null, pid: null };
  const publish = (status, reason) => {
    if (stopped) return;
    snapshot = { status, attempts, generation: active?.id ?? null, pid: active?.child?.pid ?? null, ...(reason ? { reason } : {}) };
    options.onState?.(snapshot);
  };
  const current = (g) => !stopped && active === g && !g.finishing;

  async function stopGeneration(g) {
    g.abort.abort();
    if (g.startupTimer) cancel(g.startupTimer);
    const child = g.child;
    if (!child || g.exited) return true;
    // Cooperative IPC first. Windows signals alone do not run JS cleanup.
    try { if (child.connected) child.send({ type: 'stop', generation: g.id }, () => {}); } catch { /* bounded fallback below */ }
    const wait = (ms) => new Promise((done) => {
      const timer = schedule(() => done(false), ms);
      g.exitPromise.then(() => { cancel(timer); done(true); });
    });
    if (await wait(stopMs)) return true;
    // Only the retained ChildProcess handle of this generation; never PID files, taskkill or port owners.
    if (!g.exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* Unconfirmed cleanup must block replacement, not crash Core supervision. */ }
    }
    return g.exited || await wait(stopMs);
  }

  async function fail(g, reason) {
    if (!current(g)) return;
    g.finishing = true;
    publish(g.ready ? 'degraded' : 'unavailable', reason);
    g.cleanup = stopGeneration(g);
    const cleaned = await g.cleanup;
    if (stopped || active !== g) return;
    if (!cleaned) { publish('degraded', 'cleanup_unconfirmed'); return; }
    active = undefined;
    if (attempts <= backoff.length) {
      publish(g.ready ? 'degraded' : 'unavailable', reason);
      retryTimer = schedule(() => { retryTimer = undefined; void attempt(); }, backoff[attempts - 1]);
    } else publish(g.ready ? 'degraded' : 'unavailable', 'retry_budget_exhausted');
  }

  async function attempt() {
    if (stopped || active) return;
    const g = { id: randomUUID(), abort: new AbortController(), exited: false, finishing: false, ready: false };
    active = g;
    attempts += 1;
    publish('starting');
    try {
      await checkEntry();
      if (!current(g)) return;
      const child = spawnChild(g.id);
      g.child = child;
      g.exitPromise = new Promise((done) => {
        const ended = () => { g.exited = true; done(); void fail(g, 'backend_exited'); };
        child.once('exit', ended);
        child.once('error', () => {
          // A failed spawn has no process to clean up; a runtime error may still have one.
          if (!child.pid) { g.exited = true; done(); }
          void fail(g, 'backend_error');
        });
      });
      child.on('message', async (message) => {
        if (!current(g) || g.probing || message?.type !== 'listening' || message.generation !== g.id
            || message.pid !== child.pid || message.address?.port !== spec.port || message.address?.address !== spec.host) return;
        g.probing = true;
        try {
          await probe(spec.url, g.abort.signal);
          if (!current(g) || g.exited) return;
          cancel(g.startupTimer);
          g.ready = true;
          publish('ready');
        } catch { void fail(g, 'readiness_failed'); }
      });
      g.startupTimer = schedule(() => { void fail(g, 'startup_timeout'); }, startupMs);
      options.onChild?.(child);
    } catch { void fail(g, 'runtime_unavailable'); }
  }

  return {
    start() { if (started || stopped) return; started = true; if (spec) void attempt(); else publish('disabled'); },
    state: () => ({ ...snapshot }),
    stop() {
      if (stopped) return stopPromise;
      stopped = true; // Fence callbacks before cancelling timers or awaiting cleanup.
      if (retryTimer) cancel(retryTimer);
      stopPromise = active ? (active.cleanup ?? stopGeneration(active)) : Promise.resolve(true);
      return stopPromise;
    }
  };
}

async function probeMcp(url, signal) {
  const client = new Client({ name: 'host-breakglass-gui-readiness', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const abort = () => { void client.close().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('stopped');
    await client.connect(transport, { timeout: 3000, signal });
  } finally {
    signal.removeEventListener('abort', abort);
    await client.close().catch(() => undefined);
  }
}
