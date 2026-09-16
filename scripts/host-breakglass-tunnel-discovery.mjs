/* global process */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertLoopbackHealthBase } from './tunnel-poll-health.mjs';
// Read-only diagnostics. This identity check grants no process-control authority.
export async function readReadyTunnelDiscovery(stateDir, statePath, options = {}) {
    const read = options.readFile ?? readFile;
    const raw = await read(statePath, 'utf8');
    const state = JSON.parse(raw);
    const health = (await read(join(stateDir, 'openai-tunnel-health.url'), 'utf8')).trim();
    const pid = (await read(join(stateDir, 'openai-tunnel.pid'), 'utf8')).trim();
    if (state.ready !== true || state.status !== 'ready' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.generation ?? '')
        || !Number.isInteger(state.pid) || state.pid <= 0 || String(state.pid) !== pid || state.health_base_url !== health
        || !/^\d+$/.test(String(state.creation_filetime))) {
        throw Error('Tunnel discovery is not the current ready generation');
    }
    assertLoopbackHealthBase(health);
    const actual = await (options.creationTime ?? creationTime)(state.pid);
    if (actual !== state.creation_filetime)
        throw Error('Tunnel process generation no longer exists');
    if (await read(statePath, 'utf8') !== raw)
        throw Error('Tunnel generation changed during discovery');
    return state;
}
function creationTime(pid) {
    if (process.platform !== 'win32')
        throw Error('Windows tunnel identity unavailable');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Write($p.StartTime.ToFileTimeUtc().ToString())`
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.status !== 0)
        throw Error('Tunnel process identity unavailable');
    // Both sides use Windows FILETIME, not the lower-precision CIM date representation.
    return r.stdout.trim();
}
