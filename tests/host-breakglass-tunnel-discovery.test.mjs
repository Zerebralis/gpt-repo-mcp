/* global process, setTimeout */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readReadyTunnelDiscovery } from '../scripts/host-breakglass-tunnel-discovery.mjs';
import { createTunnelRuntime } from '../scripts/host-breakglass-tunnel-runtime.mjs';
const state = { ready: true, status: 'ready', generation: randomUUID(), pid: 123, creation_filetime: '134340000000000001', health_base_url: 'http://127.0.0.1:1234' };
function discovery(change = {}, opts = {}) {
    const s = { ...state, ...change };
    return readReadyTunnelDiscovery('private', 'state.json', {
        readFile: async (p) => p === 'state.json' ? JSON.stringify(s) : p.endsWith('.pid') ? '123' : state.health_base_url,
        creationTime: async () => state.creation_filetime, ...opts
    });
}
describe('Doctor discovery fails closed', () => {
    it('accepts a current ready generation with the same Windows FILETIME', async () => { expect(await discovery()).toEqual(state); });
    it.each([{ ready: false }, { status: 'degraded' }, { pid: 999 }, { generation: null }, { health_base_url: 'http://127.0.0.1:6666' }])('rejects stale/mixed discovery %j', async (change) => { await expect(discovery(change)).rejects.toThrow(); });
    it('rejects missing discovery instead of treating it as healthy', async () => { await expect(discovery({}, { readFile: async () => { throw Error('ENOENT'); } })).rejects.toThrow('ENOENT'); });
    it('rejects PID reuse: identical PID with a different creation identity', async () => { await expect(discovery({}, { creationTime: async () => '134340000000000002' })).rejects.toThrow('generation no longer exists'); });
    it('rejects a generation changing during identity lookup', async () => { let reads = 0; await expect(discovery({}, { readFile: async (p) => p === 'state.json' ? JSON.stringify({ ...state, generation: ++reads === 1 ? state.generation : randomUUID() }) : p.endsWith('.pid') ? '123' : state.health_base_url })).rejects.toThrow('changed during discovery'); });
});
describe('actual generation startup probes on private loopback endpoints', () => {
    it.each(['never-poll', 'old-poll', 'unready', 'missing-discovery', 'foreign-listener'])('cleans up %s without publishing ready', async (mode) => {
        const root = await mkdtemp(join(tmpdir(), 'breakglass-tunnel-probe-'));
        let probes = 0, cleaned = 0, spawned = 0, started;
        const server = createServer((req, res) => { probes++; if (req.url === '/readyz') {
            res.writeHead(mode === 'unready' ? 503 : 200);
            res.end();
        }
        else
            res.end('commands_poll_last_successful_timestamp_seconds ' + (mode === 'never-poll' ? 0 : Math.floor(Date.now() / 1000) - 30)); });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const events = new EventEmitter();
        const states = [];
        const runtime = createTunnelRuntime({ stateDir: root, cwd: root, env: {}, executable: 'isolated', pollStartupTimeoutMs: 150, pollStaleMs: 180000, startupBudgetMs: 500 }, {
            backoffMs: [5000], onState: s => states.push(s), spawnOwner: spec => {
                spawned++;
                started = spec;
                // This boundary models an owned process; all discovery, readiness, freshness and cancellation code is real.
                return { events, verifyListener: async () => mode !== 'foreign-listener', stop: async () => { cleaned++; return true; } };
            }
        });
        try {
            runtime.start();
            while (!started)
                await new Promise(r => setTimeout(r, 10));
            if (mode !== 'missing-discovery') {
                await mkdir(join(root, 'tunnel-generations', started.generation), { recursive: true });
                await writeFile(started.env.HEALTH_URL_FILE, `http://127.0.0.1:${server.address().port}`);
                await writeFile(started.env.PID_FILE, String(process.pid));
            }
            events.emit('spawned', { pid: process.pid, members: [process.pid], creation_filetime: String(BigInt(Date.now()) * 10000n + 116444736000000000n) });
            const end = Date.now() + 3000;
            while (runtime.state().retry_in_ms !== 5000 && Date.now() < end)
                await new Promise(r => setTimeout(r, 20));
            expect(runtime.state()).toMatchObject({status:'backoff', recovery:'fast', retry_in_ms:5000});
            expect(states.some(s => s.ready)).toBe(false);
            expect(cleaned).toBe(1);
            expect(spawned).toBe(1);
            if (['never-poll', 'old-poll', 'unready'].includes(mode))
                expect(probes).toBeGreaterThan(0);
            if (mode === 'foreign-listener')
                expect(probes).toBe(0);
        }
        finally {
            await runtime.stop();
            server.closeAllConnections();
            await new Promise(r => server.close(r));
        }
    });
});
