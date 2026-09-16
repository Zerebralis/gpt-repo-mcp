/* global AbortController, AbortSignal, URL, fetch, setTimeout, clearTimeout */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// One private session per connector-owned Core. No discovery, remote endpoint,
// operation replay or PID adoption. The captured child PID is immutable.
export function createCoreLivenessWatchdog({ pid, port }, {
  intervalMs = 30000, timeoutMs = 5000, failureLimit = 3,
  createConnection = openProbeConnection, onFailure = () => {}, onState = () => {}
} = {}) {
  for (const value of [pid, port, intervalMs, timeoutMs, failureLimit]) {
    if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid Core liveness configuration');
  }
  if (port > 65535) throw Error('Invalid Core liveness port');
  const generation = randomUUID(), url = `http://127.0.0.1:${port}/mcp`;
  let started = false, stopped = false, failed = false, timer, active, connection;
  let snapshot = { generation, pid, status: 'idle', failures: 0, probes: 0 };
  const closing = new Set();
  const live = probe => !stopped && !failed && active === probe;
  const publish = patch => { snapshot = { ...snapshot, ...patch }; onState({ ...snapshot }); };
  function discard(current) {
    if (!current || current.discarded) return;
    current.discarded = true;
    if (connection === current) connection = undefined;
    const done = Promise.resolve().then(() => current.close()).catch(() => {});
    closing.add(done); void done.finally(() => closing.delete(done));
  }
  async function probe() {
    if (stopped || failed || active) return;
    const attempt = { abort: new AbortController() };
    active = attempt;
    let deadline, cancel, current;
    publish({ status: 'probing', probes: snapshot.probes + 1 });
    try {
      const expired = new Promise((_, reject) => {
        cancel = () => reject(Error('Core probe cancelled'));
        attempt.abort.signal.addEventListener('abort', cancel, { once: true });
        deadline = setTimeout(() => {
          reject(Error('Core probe deadline exceeded'));
          attempt.abort.abort();
        }, timeoutMs);
      });
      const operation = (async () => {
        current = connection ??= createConnection(url);
        await current.connect(attempt.abort.signal, timeoutMs);
        if (!live(attempt) || attempt.abort.signal.aborted) return;
        const result = await current.call(attempt.abort.signal, timeoutMs);
        if (!live(attempt) || attempt.abort.signal.aborted) return;
        assertCoreProbeResult(result, pid);
      })();
      await Promise.race([operation, expired]);
      if (live(attempt)) publish({ status: 'ready', failures: 0 });
    } catch {
      discard(current);
      if (!live(attempt)) return;
      const failures = snapshot.failures + 1;
      failed = failures >= failureLimit;
      publish({ status: failed ? 'failed' : 'degraded', failures });
      if (failed) onFailure({ ...snapshot }); // Exactly once; caller uses its existing shutdown.
    } finally {
      clearTimeout(deadline);
      attempt.abort.signal.removeEventListener('abort', cancel);
      if (active === attempt) active = undefined;
      if (!stopped && !failed) timer = setTimeout(() => { void probe(); }, intervalMs);
    }
  }
  let stopPromise;
  return {
    start() { if (started || stopped) return; started = true; void probe(); },
    state: () => ({ ...snapshot }),
    stop() {
      if (stopped) return stopPromise;
      stopped = true; // Fence callbacks before abort/close can synchronously report errors.
      clearTimeout(timer); active?.abort.abort(); discard(connection);
      snapshot = { ...snapshot, status: 'stopped' };
      stopPromise = Promise.allSettled([...closing]).then(() => undefined);
      return stopPromise;
    }
  };
}

export function assertCoreProbeResult(response, pid) {
  if (response?.isError) throw Error('Core functional error');
  const envelopes = [];
  for (const item of response?.content ?? []) {
    if (item.type !== 'text') continue;
    try {
      const value = JSON.parse(item.text);
      if (value && Object.hasOwn(value, 'ok')) envelopes.push(value);
    } catch { /* An audit warning is a separate content item, not the operation. */ }
  }
  if (envelopes.length !== 1 || envelopes[0].ok !== true || envelopes[0].result?.pid !== pid) {
    throw Error('Core functional response / owned PID mismatch');
  }
}

function openProbeConnection(url) {
  const abort = new AbortController();
  const client = new Client({ name: 'host-breakglass-core-liveness', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    // Recovery belongs to the watchdog. Never resume/replay a failed request.
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (target, init) => fetch(target, { ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) })
  });
  let ready, broken = false, closed = false;
  client.onerror = () => { broken = true; };
  client.onclose = () => { broken = true; };
  return {
    connect(signal, timeout) {
      if (broken || closed) throw Error('Core probe connection closed');
      return ready ??= client.connect(transport, { signal, timeout });
    },
    call(signal, timeout) {
      if (broken || closed) throw Error('Core probe connection broken');
      return client.callTool({ name: 'host_system_info', arguments: {} }, undefined, { signal, timeout });
    },
    async close() {
      if (closed) return;
      closed = true;
      const sessionId = transport.sessionId;
      abort.abort();
      await client.close().catch(() => {});
      // Retire only this private session. Abort the GET stream first, then use a
      // separate bounded DELETE because the transport's lifetime signal is closed.
      if (sessionId) await fetch(url, { method: 'DELETE', redirect: 'error', headers: { 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(500) })
        .then(response => response.body?.cancel()).catch(() => {});
    }
  };
}
