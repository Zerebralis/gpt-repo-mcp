/* global process, setTimeout, clearTimeout, URL */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
// No PID-based attach API: ownership can only arise from this helper's own spawn.
export function spawnTunnelOwner(spec, options = {}) {
    if (process.platform !== 'win32' && !options.spawn)
        throw new Error('Windows Job Object ownership required');
    const events = new EventEmitter();
    const child = (options.spawn ?? spawn)(process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./host-breakglass-tunnel-job.ps1', import.meta.url))], { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stopPromise, spawned = false, exited = false, confirmed = false;
    child.stderr.on('data', () => { }); // Do not surface command/env-bearing PowerShell diagnostics.
    child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        if (buffer.length > 65536) {
            events.emit('failed', 'owner_protocol_overflow');
            child.stdin.end();
            return;
        }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                events.emit('failed', 'owner_protocol_invalid');
                continue;
            }
            if (message.generation !== spec.generation)
                continue;
            if (message.type === 'spawned')
                spawned = true;
            if (message.type === 'stopped' && message.clean === true && message.members?.length === 0)
                confirmed = true;
            if (message.type === 'owner_error' && message.clean === true)
                confirmed = true;
            events.emit(message.type, message);
        }
    });
    child.once('error', () => events.emit('failed', 'owner_spawn_error'));
    // Drain private stdout before deciding whether the cleanup acknowledgment arrived.
    // Node's exit event can precede the last pipe data; close also confirms process exit.
    child.once('close', () => { exited = true; events.emit('owner_exit', { clean: confirmed }); });
    child.stdin.on('error', () => { });
    child.stdin.write(JSON.stringify({ ...spec, env: undefined }) + '\n');
    return {
        events, child,
        send(type) { if (!exited && child.stdin.writable)
            child.stdin.write(JSON.stringify({ type, generation: spec.generation }) + '\n'); },
        verifyListener(port) {
            return new Promise(resolve => {
                const done = message => { if (message.port !== port)
                    return; clearTimeout(timer); events.off('listener', done); resolve(message.owned === true); };
                const timer = setTimeout(() => { events.off('listener', done); resolve(false); }, 5000);
                events.on('listener', done);
                if (!exited && child.stdin.writable)
                    child.stdin.write(JSON.stringify({ type: 'listener', port, generation: spec.generation }) + '\n');
                else {
                    clearTimeout(timer);
                    events.off('listener', done);
                    resolve(false);
                }
            });
        },
        stop() {
            if (stopPromise)
                return stopPromise;
            stopPromise = new Promise(resolve => {
                if (exited) {
                    resolve(confirmed);
                    return;
                }
                const timer = setTimeout(() => { child.stdin.end(); resolve(false); }, options.stopTimeoutMs ?? 10000);
                const done = () => { clearTimeout(timer); resolve(confirmed); };
                events.once('owner_exit', done);
                // The helper may still be compiling; its buffered command is processed after suspended spawn/assignment.
                child.stdin.write(JSON.stringify({ type: 'stop', generation: spec.generation }) + '\n');
            });
            return stopPromise;
        },
        state: () => ({ spawned, exited, confirmed })
    };
}
