/* global process, setTimeout, clearTimeout */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import { spawnTunnelOwner } from '../scripts/host-breakglass-tunnel-owner.mjs';
it('waits for pipe drain after helper exit before accepting its final cleanup acknowledgment',async()=>{
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
    const generation=randomUUID();
    const owner=spawnTunnelOwner({generation,cwd:'.',env:{}},{spawn:()=>child});
    const stopped=owner.stop();child.emit('exit',0);
    expect(owner.state().exited).toBe(false);
    child.stdout.write(JSON.stringify({type:'stopped',generation,clean:true,members:[]})+'\n');
    child.emit('close',0);expect(await stopped).toBe(true);
});
const wait = (emitter, event, ms = 20000) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Timed out: ' + event)), ms); emitter.once(event, v => { clearTimeout(timer); resolve(v); }); });
const spec = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breakglass-job-test-'));
    return { generation: randomUUID(), executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir, stdout: join(dir, 'out'), stderr: join(dir, 'err'), env: process.env };
};
describe.skipIf(process.platform !== 'win32')('Windows Job Object ownership', () => {
    it('stops only its own process tree, including survivors after root death', async () => {
        const s = await spec();
        const child = join(s.cwd, 'leaf.cjs');
        await writeFile(child, 'setInterval(()=>{},1000)');
        s.args = ['-e', `require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)`];
        const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
        const owner = spawnTunnelOwner(s);
        try {
            const started = await wait(owner.events, 'spawned');
            expect(started.members).toContain(started.pid);
            await new Promise(r => setTimeout(r, 200));
            const members = wait(owner.events, 'members');
            owner.send('members');
            expect((await members).members).not.toContain(foreign.pid);
            const exited = wait(owner.events, 'root_exit');
            owner.send('terminate-root');
            await exited;
            expect(await owner.stop()).toBe(true);
            expect(foreign.exitCode).toBeNull();
            expect(owner.state().confirmed).toBe(true);
        }
        finally {
            await owner.stop();
            foreign.kill();
        }
    }, 30000);
    it('missing binary fails cleanly without ever spawning a root', async () => {
        const s = await spec();
        s.executable = join(s.cwd, 'absent.exe');
        const owner = spawnTunnelOwner(s);
        try {
            const failed = await wait(owner.events, 'owner_error');
            expect(failed.clean).toBe(true);
            expect(owner.state().spawned).toBe(false);
            expect(await owner.stop()).toBe(true);
        }
        finally {
            await owner.stop();
        }
    }, 30000);
    it('actual failed AssignProcessToJobObject never resumes the suspended process', async () => {
        const s = await spec();
        const marker = join(s.cwd, 'unprotected-start');
        s.args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`];
        const helper = join(s.cwd, 'host-breakglass-tunnel-job.ps1');
        await copyFile('scripts/host-breakglass-tunnel-job.ps1', helper);
        // Only the isolated test copy uses an invalid native job handle, exercising the real API failure branch.
        const source = await readFile('scripts/host-breakglass-tunnel-job.cs', 'utf8');
        expect(source).toContain('AssignProcessToJobObject(job,process)');
        await writeFile(join(s.cwd, 'host-breakglass-tunnel-job.cs'), source.replace('AssignProcessToJobObject(job,process)', 'AssignProcessToJobObject(IntPtr.Zero,process)'));
        const owner = spawnTunnelOwner(s, { spawn: (exe, args, opts) => spawn(exe, [...args.slice(0, -1), helper], opts) });
        try {
            expect(await wait(owner.events, 'owner_error')).toMatchObject({ clean: true, reason: 'ownership_unconfirmed' });
            expect(await owner.stop()).toBe(true);
            await expect(access(marker)).rejects.toThrow();
        }
        finally {
            await owner.stop();
        }
    }, 30000);
    it('PID files and same-name foreign processes grant no ownership', async () => {
        const s = await spec();
        await writeFile(join(s.cwd, 'tunnel.pid'), String(process.pid));
        const owner = spawnTunnelOwner(s);
        try {
            const started = await wait(owner.events, 'spawned');
            expect(started.members).not.toContain(process.pid);
            expect(await owner.stop()).toBe(true);
            expect(process.pid).toBeGreaterThan(0);
        }
        finally {
            await owner.stop();
        }
    }, 30000);
});
