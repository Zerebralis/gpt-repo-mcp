/* global AbortController, setTimeout, clearTimeout */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createTunnelRuntime, createTunnelStatePublisher, probeTunnelReady } from '../scripts/host-breakglass-tunnel-runtime.mjs';
const flush = async () => { for (let i = 0; i < 12; i++)
    await Promise.resolve(); };
const spec = { stateDir: 'isolated', executable: 'fake', cwd: '.', env: {}, pollStartupTimeoutMs: 90000, pollStaleMs: 180000, startupBudgetMs: 15000 };
function harness(extra = {}) {
    const owners = [], watchdogs = [], states = [];
    const runtime = createTunnelRuntime(spec, {
        mkdir: async () => { }, prepare: async () => ({ base: 'http://127.0.0.1:9001', poll: { lastSuccessUnixSeconds: 1 } }),
        spawnOwner: () => { const o = { events: new EventEmitter(), stop: vi.fn(async () => true) }; owners.push(o); return o; },
        createWatchdog: o => { const w = { ...o, start: vi.fn(), stop: vi.fn() }; watchdogs.push(w); return w; }, onState: s => states.push(s), ...extra
    });
    const spawned = async (index = owners.length - 1) => { owners[index].events.emit('spawned', { pid: 100 + index, members: [100 + index], creation_filetime: '134340000000000000' }); await flush(); };
    return { runtime, owners, watchdogs, states, spawned };
}
async function recoveredHarness() {
    const schedule = vi.fn((callback, ms) => setTimeout(callback, ms));
    const cancel = vi.fn(timer => clearTimeout(timer));
    const h = harness({schedule, cancel});
    h.runtime.start();
    await flush();
    for (const ms of [2000, 5000, 15000]) {
        await h.spawned();
        h.owners.at(-1).events.emit('root_exit');
        await flush();
        await vi.advanceTimersByTimeAsync(ms);
    }
    await h.spawned();
    const resets = () => schedule.mock.calls.flatMap(([callback, ms], index) =>
        ms === 300000 ? [{callback, timer:schedule.mock.results[index].value}] : []);
    expect(h.runtime.state()).toMatchObject({status:'ready', attempts:4, failure_streak:3});
    return {...h, schedule, cancel, resets};
}
afterEach(() => vi.useRealTimers());
describe('connector-local tunnel generations', () => {
    it.each([10000, 299000])('ready for %sms does not reset the failure streak', async ms => {
        vi.useFakeTimers();const h = await recoveredHarness();
        await vi.advanceTimersByTimeAsync(ms);
        expect(h.runtime.state()).toMatchObject({attempts:4, failure_streak:3});
        h.owners.at(-1).events.emit('root_exit');await flush();
        expect(h.runtime.state()).toMatchObject({attempts:4, failure_streak:4, recovery:'slow', retry_in_ms:30000});
        expect(h.cancel).toHaveBeenCalledWith(h.resets().at(-1).timer);
        await h.runtime.stop();
    });
    it('at exactly five minutes resets only the recovery streak and starts the next failure sequence at 2s', async () => {
        vi.useFakeTimers();const h = await recoveredHarness();const before = h.runtime.state();
        await vi.advanceTimersByTimeAsync(299000);expect(h.runtime.state()).toEqual(before);
        await vi.advanceTimersByTimeAsync(999);expect(h.runtime.state()).toEqual(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.runtime.state()).toEqual({...before, failure_streak:0});
        expect(h.owners).toHaveLength(4);
        for (const [index, ms] of [2000,5000,15000,30000,60000].entries()) {
            h.owners.at(-1).events.emit('root_exit');await flush();
            expect(h.runtime.state()).toMatchObject({attempts:4+index, failure_streak:index+1, retry_in_ms:ms});
            await vi.advanceTimersByTimeAsync(ms);await h.spawned();
        }
        await h.runtime.stop();
    });
    it('a canceled stable-ready callback cannot change the next generation', async () => {
        vi.useFakeTimers();const h = await recoveredHarness();const old = h.resets().at(-1);
        await vi.advanceTimersByTimeAsync(299000);
        h.owners.at(-1).events.emit('root_exit');await flush();
        await vi.advanceTimersByTimeAsync(30000);await h.spawned();
        const current = h.runtime.state();old.callback();
        expect(h.runtime.state()).toEqual(current);
        expect(h.cancel).toHaveBeenCalledWith(old.timer);
        await vi.advanceTimersByTimeAsync(299999);
        expect(h.runtime.state()).toEqual(current);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.runtime.state()).toEqual({...current, failure_streak:0});
        await h.runtime.stop();
    });
    it('an unhealthy probe interrupts the window without changing the watchdog recycle threshold', async () => {
        vi.useFakeTimers();const h = await recoveredHarness();const old = h.resets().at(-1);
        await vi.advanceTimersByTimeAsync(299000);h.watchdogs.at(-1).onFailure(1);
        await vi.advanceTimersByTimeAsync(1000);expect(h.runtime.state().failure_streak).toBe(3);
        h.watchdogs.at(-1).onHealthy(1);old.callback();
        expect(h.runtime.state()).toMatchObject({status:'ready',attempts:4,failure_streak:3});
        await vi.advanceTimersByTimeAsync(299999);expect(h.runtime.state().failure_streak).toBe(3);
        await vi.advanceTimersByTimeAsync(1);expect(h.runtime.state().failure_streak).toBe(0);
        expect(h.owners).toHaveLength(4);await h.runtime.stop();
    });
    it('shutdown cancels stable-ready reset and fences a late callback', async () => {
        vi.useFakeTimers();const h = await recoveredHarness();const old = h.resets().at(-1);
        await h.runtime.stop();const current=h.runtime.state(), count=h.states.length;
        expect(h.cancel).toHaveBeenCalledWith(old.timer);old.callback();
        await vi.advanceTimersByTimeAsync(24*60*60*1000);
        expect(h.runtime.state()).toEqual(current);expect(h.states).toHaveLength(count);
        expect(h.owners).toHaveLength(4);
    });
    it.each(['cleanup','ownership'])('stable-ready reset cannot escape terminal %s uncertainty', async kind => {
        vi.useFakeTimers();const h = await recoveredHarness();const old=h.resets().at(-1);
        if(kind==='cleanup'){
            h.owners.at(-1).stop.mockResolvedValue(false);h.owners.at(-1).events.emit('root_exit');
        }else h.owners.at(-1).events.emit('owner_error',{clean:true,reason:'ownership_unconfirmed'});
        await flush();const current=h.runtime.state();
        expect(current.reason).toBe('cleanup_unconfirmed');
        expect(h.cancel).toHaveBeenCalledWith(old.timer);old.callback();
        await vi.advanceTimersByTimeAsync(24*60*60*1000);
        expect(h.runtime.state()).toEqual(current);expect(h.owners).toHaveLength(4);
        await h.runtime.stop();
    });
    it.each([[true, 0, false], [true, 300, false], [false, 1, false], [true, 1, true]])('requires ready=%s and fresh successful poll age=%s', async (ready, age, expected) => {
        const now = Date.now() / 1000;
        const value = age === 0 ? 0 : now - age;
        const fetchImpl = async (url) => url.endsWith('/readyz') ? { ok: ready } : { ok: true, text: async () => `commands_poll_last_successful_timestamp_seconds ${value}` };
        expect(await probeTunnelReady('http://127.0.0.1:5', spec, new AbortController().signal, fetchImpl)).toBe(expected);
    });
    it('uses 2s/5s fast retries then degraded slow recovery at 15s/30s/60s, capped without a short-ready reset', async () => {
        vi.useFakeTimers();
        const h = harness();
        h.runtime.start();
        await flush();
        const delays = [2000, 5000, 15000, 30000, 60000, 60000, 60000];
        for (let i = 0; i < delays.length; i++) {
            await h.spawned();
            expect(h.runtime.state().status).toBe('ready');
            h.owners[i].events.emit('root_exit');
            await flush();
            expect(h.owners[i].stop).toHaveBeenCalledTimes(1);
            expect(h.runtime.state()).toMatchObject({status:i<2?'backoff':'degraded', recovery:i<2?'fast':'slow', retry_in_ms:delays[i], ready:false});
            await vi.advanceTimersByTimeAsync(delays[i]-1);
            expect(h.owners).toHaveLength(i+1);
            await vi.advanceTimersByTimeAsync(1);
            expect(h.owners).toHaveLength(i+2);
        }
        await h.spawned();
        expect(h.runtime.state()).toMatchObject({status:'ready',attempts:8});
        await h.runtime.stop();
    });
    it.each(['root_exit', 'owner_error', 'failed', 'owner_exit'])('handles %s without duplicate cleanup', async (event) => {
        const h = harness();
        h.runtime.start();
        await flush();
        await h.spawned();
        h.owners[0].events.emit(event);
        h.owners[0].events.emit('root_exit');
        await flush();
        expect(h.owners[0].stop).toHaveBeenCalledTimes(1);
        await h.runtime.stop();
    });
    it('blocks replacement when cleanup is unconfirmed', async () => {
        vi.useFakeTimers();
        const h = harness();
        h.runtime.start();
        await flush();
        h.owners[0].stop.mockResolvedValue(false);
        h.owners[0].events.emit('root_exit');
        await flush();
        expect(h.runtime.state().reason).toBe('cleanup_unconfirmed');
        await vi.advanceTimersByTimeAsync(24*60*60*1000);
        expect(h.owners).toHaveLength(1);
        await h.runtime.stop();
    });
    it('failed Job Object assignment blocks replacement even after suspended-root cleanup', async () => {
        vi.useFakeTimers();
        const h = harness();
        h.runtime.start();
        await flush();
        h.owners[0].events.emit('owner_error', { clean: true, reason: 'ownership_unconfirmed' });
        await flush();
        expect(h.runtime.state()).toMatchObject({ reason: 'cleanup_unconfirmed', detail: 'ownership_unconfirmed' });
        await vi.advanceTimersByTimeAsync(24*60*60*1000);
        expect(h.owners).toHaveLength(1);
        await h.runtime.stop();
    });
    it('does not overlap generations while cleanup is pending', async () => {
        vi.useFakeTimers();
        let finish;
        const h = harness();
        h.runtime.start();
        await flush();
        h.owners[0].stop.mockImplementation(() => new Promise(r => { finish = r; }));
        h.owners[0].events.emit('root_exit');
        await vi.advanceTimersByTimeAsync(60000);
        expect(h.owners).toHaveLength(1);
        finish(true);
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.owners).toHaveLength(2);
        await h.runtime.stop();
    });
    it('ignores delayed old readiness, error, exit and watchdog callbacks', async () => {
        vi.useFakeTimers();
        let ready;
        let count = 0;
        const h = harness({ prepare: () => ++count === 1 ? new Promise(r => { ready = r; }) : Promise.resolve({ base: 'http://127.0.0.1:9002', poll: { lastSuccessUnixSeconds: 2 } }) });
        h.runtime.start();
        await flush();
        await h.spawned();
        h.owners[0].events.emit('root_exit');
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        await h.spawned();
        const current = h.runtime.state();
        ready({ base: 'http://127.0.0.1:9999', poll: { lastSuccessUnixSeconds: 99 } });
        h.owners[0].events.emit('owner_error');
        h.owners[0].events.emit('owner_exit');
        await flush();
        expect(h.runtime.state()).toEqual(current);
        await h.runtime.stop();
    });
    it('ignores old watchdog after next generation is ready', async () => {
        vi.useFakeTimers();
        const h = harness();
        h.runtime.start();
        await flush();
        await h.spawned();
        const old = h.watchdogs[0];
        old.onThreshold();
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        await h.spawned();
        const current = h.runtime.state();
        old.onThreshold();
        await flush();
        expect(h.runtime.state()).toEqual(current);
        expect(old.stop).toHaveBeenCalled();
        await h.runtime.stop();
    });
    it('late poll probe cannot report health for a replacement generation', async () => {
        vi.useFakeTimers();
        let complete;
        const h = harness({ probe: () => new Promise(r => { complete = r; }) });
        h.runtime.start();
        await flush();
        await h.spawned();
        const old = h.watchdogs[0], pending = old.probe();
        h.owners[0].events.emit('root_exit');
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        await h.spawned();
        const current = h.runtime.state();
        complete(true);
        expect(await pending).toBe(false);
        old.onThreshold();
        expect(h.runtime.state()).toEqual(current);
        await h.runtime.stop();
    });
    it('startup without poll or readiness times out and cleans up', async () => {
        vi.useFakeTimers();
        const h = harness({ prepare: () => new Promise(() => { }) });
        h.runtime.start();
        await flush();
        await h.spawned();
        await vi.advanceTimersByTimeAsync(15000);
        expect(h.owners[0].stop).toHaveBeenCalledTimes(1);
        expect(h.runtime.state().status).toBe('backoff');
        await h.runtime.stop();
    });
    it('recovers after a long missing-binary outage without restarting the runtime', async () => {
        vi.useFakeTimers();
        let available=false;
        const events=new EventEmitter();
        const spawnOwner = vi.fn(() => {
            if(!available)throw Error('missing binary');
            return {events,stop:async()=>true};
        });
        const h = harness({ spawnOwner });
        h.runtime.start();
        await flush();
        await vi.advanceTimersByTimeAsync(7000);
        expect(spawnOwner).toHaveBeenCalledTimes(3);
        expect(h.runtime.state()).toMatchObject({status:'degraded',recovery:'slow',retry_in_ms:15000});
        await vi.advanceTimersByTimeAsync(15000+30000+60*60000);
        expect(spawnOwner).toHaveBeenCalledTimes(65);
        expect(h.runtime.state()).toMatchObject({status:'degraded',recovery:'slow',retry_in_ms:60000});
        available=true;
        await vi.advanceTimersByTimeAsync(59999);
        expect(spawnOwner).toHaveBeenCalledTimes(65);
        await vi.advanceTimersByTimeAsync(1);
        events.emit('spawned',{pid:777,members:[777],creation_filetime:'134340000000000000'});
        await flush();
        expect(h.runtime.state()).toMatchObject({status:'ready',attempts:66});
        await h.runtime.stop();
    });
    it('shutdown during slow backoff cancels all later recovery starts',async()=>{
        vi.useFakeTimers();
        const spawnOwner=vi.fn(()=>{throw Error('temporary spawn error');});
        const h=harness({spawnOwner});h.runtime.start();await flush();
        await vi.advanceTimersByTimeAsync(7000);
        expect(h.runtime.state()).toMatchObject({status:'degraded',recovery:'slow'});
        await h.runtime.stop();const states=h.states.length;
        await vi.advanceTimersByTimeAsync(24*60*60*1000);
        expect(spawnOwner).toHaveBeenCalledTimes(3);expect(h.states).toHaveLength(states);
    });
    it('slow recovery still waits for confirmed cleanup before scheduling the next generation',async()=>{
        vi.useFakeTimers();const h=harness();h.runtime.start();await flush();
        for(const ms of [2000,5000]){await h.spawned();h.owners.at(-1).events.emit('root_exit');await flush();await vi.advanceTimersByTimeAsync(ms);}
        await h.spawned();let cleaned;
        h.owners[2].stop.mockImplementation(()=>new Promise(r=>{cleaned=r;}));
        h.owners[2].events.emit('root_exit');await flush();
        await vi.advanceTimersByTimeAsync(60*60*1000);expect(h.owners).toHaveLength(3);
        cleaned(true);await flush();expect(h.runtime.state()).toMatchObject({recovery:'slow',retry_in_ms:15000});
        await vi.advanceTimersByTimeAsync(14999);expect(h.owners).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);expect(h.owners).toHaveLength(4);await h.runtime.stop();
    });
    it.each(['backoff', 'probe'])('shutdown during %s fences every callback', async (phase) => {
        vi.useFakeTimers();
        let finish;
        const h = harness(phase === 'probe' ? { prepare: () => new Promise(r => { finish = r; }) } : {});
        h.runtime.start();
        await flush();
        await h.spawned();
        if (phase === 'backoff') {
            h.owners[0].events.emit('root_exit');
            await flush();
        }
        await h.runtime.stop();
        const n = h.states.length;
        if (finish)
            finish({ base: 'http://127.0.0.1:9', poll: { lastSuccessUnixSeconds: 1 } });
        await vi.advanceTimersByTimeAsync(60000);
        expect(h.states).toHaveLength(n);
        expect(h.owners).toHaveLength(1);
    });
    it('refuses unconfirmed spawned PID membership, including reused external PID', async () => {
        vi.useFakeTimers();
        const h = harness();
        h.runtime.start();
        await flush();
        h.owners[0].events.emit('spawned', { pid: 77, members: [88] });
        await flush();
        expect(h.runtime.state().ready).toBe(false);
        expect(h.owners[0].stop).toHaveBeenCalled();
        expect(h.runtime.state()).toMatchObject({reason:'cleanup_unconfirmed',detail:'ownership_unconfirmed'});
        await vi.advanceTimersByTimeAsync(24*60*60*1000);
        expect(h.owners).toHaveLength(1);
        await h.runtime.stop();
    });
    it('serializes state writes and never renames a delayed old generation over the current one', async () => {
        let release;
        const files = new Map();
        let delayed = true;
        const io = { writeFile: vi.fn(async (path, body) => { files.set(path, body); if (delayed) {
                delayed = false;
                await new Promise(r => { release = r; });
            } }), rename: vi.fn(async (a, b) => { files.set(b, files.get(a)); files.delete(a); }), rm: vi.fn(async (p) => { files.delete(p); }) };
        const p = createTunnelStatePublisher('state', 'connector.json', {}, { io });
        const first = p.publish({ ready: true, generation: 'old', health_base_url: 'http://127.0.0.1:1', pid: 1 });
        await flush();
        const second = p.publish({ ready: true, generation: 'new', health_base_url: 'http://127.0.0.1:2', pid: 2 });
        release();
        await Promise.all([first, second]);
        expect(JSON.parse(files.get('connector.json')).generation).toBe('new');
        expect(io.rename.mock.calls.some(([a]) => a.endsWith('.next-1'))).toBe(false);
        await p.publish({ ready: false, generation: 'new', status: 'degraded' });
        expect([...files.keys()].some(p => p.endsWith('health.url'))).toBe(false);
        expect(JSON.parse(files.get('connector.json')).ready).toBe(false);
    });
    it.each(['state-write', 'alias-remove'])('invalidates the other discovery view when %s fails', async (failure) => {
        const files = new Map(), io = { writeFile: async (p, b) => { files.set(p, b); }, rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, rm: async (p) => { files.delete(p); } };
        const p = createTunnelStatePublisher('state', 'connector.json', {}, { io });
        await p.publish({ ready: true, generation: 'old', health_base_url: 'http://127.0.0.1:1', pid: 1 });
        if (failure === 'state-write')
            io.writeFile = async () => { throw Error('state write failed'); };
        else
            io.rm = async () => { throw Error('alias removal failed'); };
        await expect(p.publish({ ready: false, generation: 'old', status: 'degraded' })).rejects.toThrow();
        if (failure === 'state-write')
            expect([...files.keys()].some(k => k.endsWith('health.url'))).toBe(false);
        else
            expect(JSON.parse(files.get('connector.json')).ready).toBe(false);
    });
});
