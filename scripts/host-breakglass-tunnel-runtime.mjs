/* global setTimeout, clearTimeout, URL, AbortController, fetch, AbortSignal */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnTunnelOwner } from './host-breakglass-tunnel-owner.mjs';
import { createReadinessWatchdog } from './tunnel-readiness-watchdog.mjs';
import { probeTunnelPollHealth, assertLoopbackHealthBase } from './tunnel-poll-health.mjs';
export function createTunnelRuntime(spec, options = {}) {
    const spawnOwner = options.spawnOwner ?? spawnTunnelOwner;
    const schedule = options.schedule ?? setTimeout;
    const cancel = options.cancel ?? clearTimeout;
    const backoff = options.backoffMs ?? [2000, 5000, 15000, 30000, 60000];
    if (!Array.isArray(backoff) || !backoff.length || backoff.some(ms => !Number.isInteger(ms) || ms <= 0 || ms > 60000))
        throw new Error('Tunnel backoff must contain positive delays capped at 60000ms');
    let active, attempts = 0, failureStreak = 0, started = false, stopped = false, retryTimer, stopPromise;
    let snapshot = { status: 'unavailable', generation: null, attempts: 0, failure_streak: 0, ready: false };
    const current = g => !stopped && active === g && !g.finishing;
    const publish = (g, status, detail = {}) => {
        if (stopped || active !== g)
            return;
        snapshot = { status, generation: g.id, attempts, failure_streak: failureStreak, ready: status === 'ready', pid: g.pid ?? null, creation_filetime: g.creationFileTime ?? null, ...detail };
        options.onState?.({ ...snapshot });
    };
    function cancelStableReady(g) {
        if (g.stableTimer !== undefined)
            cancel(g.stableTimer);
        g.stableTimer = undefined;
        g.stableToken = undefined;
    }
    function armStableReady(g) {
        cancelStableReady(g);
        if (!current(g) || snapshot.status !== 'ready')
            return;
        const token = {};
        g.stableToken = token;
        g.stableTimer = schedule(() => {
            if (!current(g) || g.stableToken !== token || snapshot.status !== 'ready')
                return;
            g.stableTimer = undefined;
            g.stableToken = undefined;
            failureStreak = 0;
            publish(g, 'ready', g.readyDetail);
        }, 5 * 60 * 1000);
    }
    async function stopGeneration(g) {
        cancelStableReady(g);
        g.abort.abort();
        g.watchdog?.stop();
        if (g.startTimer)
            cancel(g.startTimer);
        if (!g.owner)
            return true;
        try {
            return await g.owner.stop();
        }
        catch {
            return false;
        }
    }
    async function fail(g, reason, ownershipFailure = false) {
        if (!current(g))
            return;
        g.finishing = true;
        failureStreak++;
        publish(g, 'degraded', { reason });
        g.cleanup = stopGeneration(g);
        const clean = await g.cleanup;
        if (stopped || active !== g)
            return;
        if (!clean || ownershipFailure) {
            publish(g, 'degraded', { reason: 'cleanup_unconfirmed', ...(ownershipFailure ? { detail: 'ownership_unconfirmed' } : {}) });
            return;
        }
        // The only remote recovery transport keeps trying after transient failures.
        // Short-lived readiness never resets the delay; only confirmed cleanup permits a retry.
        const retryMs = backoff[Math.min(failureStreak - 1, backoff.length - 1)];
        const slowRecovery = failureStreak >= 3;
        publish(g, slowRecovery ? 'degraded' : 'backoff', { reason, recovery: slowRecovery ? 'slow' : 'fast', retry_in_ms: retryMs });
        retryTimer = schedule(() => {
            retryTimer = undefined;
            if (stopped || active !== g)
                return;
            active = undefined;
            void attempt();
        }, retryMs);
    }
    async function ready(g) {
        try {
            const probe = options.prepare ?? prepareTunnel;
            const health = await probe(g, { ...spec, isCurrent: () => current(g) });
            if (!current(g))
                return;
            g.health = health;
            cancel(g.startTimer);
            g.readyDetail = { health_base_url: health.base, control_plane_poll_last_success_unix_seconds: health.poll.lastSuccessUnixSeconds, control_plane_poll_stale_after_ms: spec.pollStaleMs };
            publish(g, 'ready', g.readyDetail);
            armStableReady(g);
            g.watchdog = (options.createWatchdog ?? createReadinessWatchdog)({
                probe: async () => {
                    if (!current(g))
                        return false;
                    try {
                        const ok = await (options.probe ?? probeTunnelReady)(health.base, spec, g.abort.signal);
                        return current(g) && ok;
                    }
                    catch {
                        return false;
                    }
                }, intervalMs: spec.watchdogIntervalMs ?? 10000, failureThreshold: 3,
                // Even a probe failure below the recycle threshold interrupts stable readiness.
                onFailure: () => { if (current(g)) cancelStableReady(g); },
                onHealthy: () => { if (current(g)) armStableReady(g); },
                onThreshold: () => { if (current(g))
                    void fail(g, 'readiness_or_poll_lost'); }
            });
            if (current(g))
                g.watchdog.start();
        }
        catch {
            if (current(g))
                void fail(g, 'startup_readiness_failed');
        }
    }
    async function attempt() {
        if (stopped || active)
            return;
        const g = { id: randomUUID(), abort: new AbortController(), finishing: false };
        active = g;
        attempts++;
        publish(g, 'starting');
        try {
            g.dir = join(spec.stateDir, 'tunnel-generations', g.id);
            await (options.mkdir ?? mkdir)(g.dir, { recursive: true });
            if (!current(g))
                return;
            g.startTimer = schedule(() => { if (current(g))
                void fail(g, 'startup_timeout'); }, spec.startupBudgetMs ?? (30000 + 15000 + 20000 + spec.pollStartupTimeoutMs));
            g.owner = spawnOwner({ generation: g.id, executable: spec.executable, args: ['run'], cwd: spec.cwd, stdout: join(g.dir, 'stdout.log'), stderr: join(g.dir, 'stderr.log'), env: { ...spec.env, HEALTH_LISTEN_ADDR: '127.0.0.1:0', HEALTH_URL_FILE: join(g.dir, 'health.url'), PID_FILE: join(g.dir, 'tunnel.pid') } });
            g.owner.events.once('spawned', m => {
                if (!current(g) || g.pid)
                    return;
                if (!Number.isInteger(m.pid) || m.pid <= 0 || !m.members?.includes(m.pid) || !/^\d+$/.test(m.creation_filetime ?? '')) {
                    void fail(g, 'ownership_unconfirmed', true);
                    return;
                }
                g.pid = m.pid;
                g.creationFileTime = m.creation_filetime;
                void ready(g);
            });
            for (const event of ['root_exit', 'owner_error', 'failed', 'owner_exit'])
                g.owner.events.once(event, m => { if (current(g))
                    void fail(g, event, m?.reason === 'ownership_unconfirmed'); });
        }
        catch {
            if (current(g))
                void fail(g, 'spawn_failed');
        }
    }
    return {
        start() { if (started || stopped)
            return; started = true; void attempt(); },
        state: () => ({ ...snapshot }),
        stop() {
            if (stopped)
                return stopPromise;
            stopped = true;
            if (retryTimer)
                cancel(retryTimer);
            stopPromise = active ? (active.cleanup ?? stopGeneration(active)) : Promise.resolve(true);
            return stopPromise;
        }
    };
}
async function waitUntil(g, ms, probe, isCurrent) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !g.abort.signal.aborted && isCurrent()) {
        const result = await probe();
        if (g.abort.signal.aborted || !isCurrent())
            throw Error('Generation stopped');
        if (result)
            return result;
        await new Promise(resolve => {
            const done = () => { clearTimeout(timer); g.abort.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, 100);
            g.abort.signal.addEventListener('abort', done, { once: true });
            if (g.abort.signal.aborted)
                done();
        });
    }
    throw Error('Tunnel startup deadline exceeded');
}
async function prepareTunnel(g, spec) {
    const base = await waitUntil(g, 15000, async () => {
        try {
            const pid = (await readFile(join(g.dir, 'tunnel.pid'), 'utf8')).trim();
            if (pid !== String(g.pid))
                return false;
            return assertLoopbackHealthBase((await readFile(join(g.dir, 'health.url'), 'utf8')).trim());
        }
        catch {
            return false;
        }
    }, spec.isCurrent);
    // Private, never-reused files plus our live spawn identity; listeners are never adopted/killed.
    if (!await g.owner.verifyListener(Number(new URL(base).port)))
        throw Error('Health listener not owned');
    if (!spec.isCurrent())
        throw Error('Generation stopped');
    await waitUntil(g, 20000, async () => {
        try {
            return (await fetch(base + '/readyz', { signal: AbortSignal.any([g.abort.signal, AbortSignal.timeout(1000)]) })).ok;
        }
        catch {
            return false;
        }
    }, spec.isCurrent);
    const poll = await waitUntil(g, spec.pollStartupTimeoutMs, async () => {
        try {
            const p = await probeTunnelPollHealth(base, { staleMs: spec.pollStaleMs, timeoutMs: 2000, signal: g.abort.signal });
            // The new process must have polled, not merely a stale endpoint from before this spawn.
            const earliest = Number(BigInt(g.creationFileTime) / 10000000n - 11644473600n);
            return p.fresh && p.lastSuccessUnixSeconds >= earliest ? p : false;
        }
        catch {
            return false;
        }
    }, spec.isCurrent);
    if (!await probeTunnelReady(base, spec, g.abort.signal))
        throw Error('Readiness lost during poll wait');
    return { base, poll };
}
export async function probeTunnelReady(base, spec, signal, fetchImpl = fetch) {
    const ready = await fetchImpl(base + '/readyz', { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
    if (!ready.ok)
        return false;
    return (await probeTunnelPollHealth(base, { staleMs: spec.pollStaleMs, timeoutMs: 2000, signal, fetchImpl })).fresh;
}
// Only this serialized publisher writes compatibility views. A generation never deletes them itself.
export function createTunnelStatePublisher(stateDir, statePath, common = {}, options = {}) {
    let revision = 0, chain = Promise.resolve();
    const io = options.io ?? { writeFile, rename, rm };
    const atomic = async (path, body, rev) => {
        if (rev !== revision)
            return;
        const tmp = path + '.next-' + rev;
        await io.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
        if (rev !== revision) {
            await io.rm(tmp, { force: true });
            return;
        }
        await io.rename(tmp, path);
    };
    return {
        publish(state) {
            const rev = ++revision;
            chain = chain.catch(() => { }).then(async () => {
                if (rev !== revision)
                    return;
                const body = JSON.stringify({ ...common, ok: state.ready === true, updated_at: new Date().toISOString(), ...state }, null, 2);
                // Publish degradation even when alias removal fails; invalidate aliases even when state writing fails.
                // A serialized successor always runs last, and Doctor requires all views to agree.
                if (state.ready !== true) {
                    let failure;
                    try {
                        await atomic(statePath, body, rev);
                    }
                    catch (error) {
                        failure = error;
                    }
                    for (const name of ['openai-tunnel-health.url', 'openai-tunnel.pid']) {
                        if (rev !== revision)
                            return;
                        try {
                            await io.rm(join(stateDir, name), { force: true });
                        }
                        catch (error) {
                            failure ??= error;
                        }
                    }
                    if (failure)
                        throw failure;
                }
                else {
                    await atomic(join(stateDir, 'openai-tunnel-health.url'), state.health_base_url + '\n', rev);
                    await atomic(join(stateDir, 'openai-tunnel.pid'), String(state.pid) + '\n', rev);
                    if (rev !== revision)
                        return;
                    await atomic(statePath, body, rev);
                }
            });
            return chain;
        },
        flush: () => chain
    };
}
