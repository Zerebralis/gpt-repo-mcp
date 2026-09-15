export function createReadinessWatchdog(options = {}) {
  const probe = options.probe;
  const onThreshold = options.onThreshold;
  if (typeof probe !== 'function') throw new Error('probe is required');
  if (typeof onThreshold !== 'function') throw new Error('onThreshold is required');
  const intervalMs = Number(options.intervalMs ?? 10000);
  const failureThreshold = Number(options.failureThreshold ?? 3);
  const schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.cancel ?? ((timer) => globalThis.clearTimeout(timer));
  const onFailure = options.onFailure ?? (() => undefined);
  const onHealthy = options.onHealthy ?? (() => undefined);
  let timer = null;
  let stopped = false;
  let consecutiveFailures = 0;

  async function tick() {
    timer = null;
    if (stopped) return;
    let ok = false;
    try { ok = (await probe()) === true; } catch { ok = false; }
    if (stopped) return;
    if (ok) {
      if (consecutiveFailures > 0) onHealthy(consecutiveFailures);
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      onFailure(consecutiveFailures);
      if (consecutiveFailures >= failureThreshold) {
        stopped = true;
        onThreshold(consecutiveFailures);
        return;
      }
    }
    timer = schedule(tick, intervalMs);
    timer?.unref?.();
  }

  function start() {
    if (stopped || timer !== null) return;
    timer = schedule(tick, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer !== null) cancel(timer);
    timer = null;
  }

  return { start, stop, state: () => ({ stopped, consecutiveFailures }) };
}
