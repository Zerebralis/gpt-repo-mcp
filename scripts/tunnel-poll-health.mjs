/* global fetch, AbortSignal, URL */

export const POLL_LAST_SUCCESS_METRIC = 'commands_poll_last_successful_timestamp_seconds';

export function parseLastSuccessfulPoll(metricsText) {
  let newest = null;
  for (const rawLine of String(metricsText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/);
    if (!match || !match[1].endsWith(POLL_LAST_SUCCESS_METRIC)) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (newest === null || value > newest) newest = value;
  }
  return newest;
}

export function classifyPollFreshness(lastSuccessUnixSeconds, { nowMs = Date.now(), staleMs = 180000 } = {}) {
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new Error('staleMs must be a positive finite number');
  if (!Number.isFinite(lastSuccessUnixSeconds) || lastSuccessUnixSeconds <= 0) {
    return { fresh: false, status: 'never_succeeded', lastSuccessUnixSeconds: 0, ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - (lastSuccessUnixSeconds * 1000));
  return {
    fresh: ageMs <= staleMs,
    status: ageMs <= staleMs ? 'fresh' : 'stale',
    lastSuccessUnixSeconds,
    ageMs
  };
}

export async function probeTunnelPollHealth(healthBase, {
  staleMs = 180000,
  timeoutMs = 2000,
  nowMs = Date.now(),
  fetchImpl = fetch
} = {}) {
  const base = assertLoopbackHealthBase(healthBase);
  const response = await fetchImpl(`${base}/metrics`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`tunnel-client metrics probe failed status=${response.status}`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('tunnel-client metrics response exceeded 2 MiB');
  const lastSuccess = parseLastSuccessfulPoll(body);
  return classifyPollFreshness(lastSuccess ?? 0, { nowMs, staleMs });
}

export function assertLoopbackHealthBase(value) {
  const url = new URL(String(value));
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || host !== '127.0.0.1' || !url.port || url.username || url.password) {
    throw new Error('tunnel-client health base must be an IPv4 loopback URL');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('tunnel-client health base must not contain path, query, or fragment');
  }
  return url.origin;
}
