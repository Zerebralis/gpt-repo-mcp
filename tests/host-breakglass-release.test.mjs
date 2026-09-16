/* global process, Buffer, fetch, AbortSignal, setTimeout, URL */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { buildRelease, checkoutIdentity, releaseArchive, RUNTIME_FILES, sha256 } from '../scripts/build-host-breakglass-release.mjs';

const root = process.cwd();
let fixture, first, second, core;
const sleep = ms => new Promise(r => setTimeout(r, ms));
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'breakglass-release-test-'));
  expect(resolve(fixture).startsWith(resolve(root))).toBe(false);
  for (let p = fixture; ; p = dirname(p)) {
    await expect(access(join(p, 'node_modules'))).rejects.toBeDefined();
    if (dirname(p) === p) break;
  }
  first = await buildRelease({ out: join(fixture, 'one'), preview: true });
  second = await buildRelease({ out: join(fixture, 'two'), preview: true });
}, 60000);
afterAll(async () => { if (core && core.exitCode === null && core.signalCode === null) { core.kill(); await once(core, 'exit'); } });

describe('self-contained Host Breakglass release packaging', () => {
  it('reproduces the original unbundled GUI SDK dependency failure outside the repository', async () => {
    const unbundled = join(fixture, 'unbundled.mjs');
    await copyFile(join(root, 'scripts/host-breakglass-gui-runtime.mjs'), unbundled);
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    expect(() => execFileSync(process.execPath, [unbundled], { cwd: fixture, env, windowsHide: true, stdio: 'pipe' })).toThrow(/Cannot find package '@modelcontextprotocol\/sdk'/);
  });
  it('rejects dirty checkouts before a release build; preview is explicit', async () => {
    const dirty = join(fixture, 'dirty'); await mkdir(dirty);
    execFileSync('git', ['init', '-q', dirty]); await writeFile(join(dirty, 'untracked'), 'dirty');
    expect(() => checkoutIdentity(dirty)).toThrow('CLEAN');
    expect(first.manifest.kind).toBe('review-preview');
  });
  it('reproduces identical manifests, bundles and archive bytes in different output directories', async () => {
    expect(first.manifest).toEqual(second.manifest);
    expect(await readFile(first.artifact)).toEqual(await readFile(second.artifact));
    expect(first.sha256).toBe(second.sha256);
  });
  it('binds versions, sources, builder, lock and every payload byte without host metadata', async () => {
    expect(first.manifest).toMatchObject({ sdk_version: '1.29.0', bundler: { name: 'esbuild', version: '0.27.7' }, schema: 'host-breakglass-release.v1', builder_version: 1 });
    expect(first.manifest.package_lock_sha256).toBe(sha256(await readFile(join(root, 'package-lock.json'))));
    expect(first.manifest.gui.source_sha256).toBe(sha256(await readFile(join(root, 'scripts/host-breakglass-gui-runtime.mjs'))));
    const seen = [];
    async function walk(dir, prefix = '') { for (const item of await readdir(dir, { withFileTypes: true })) { const p = prefix + item.name; if (item.isDirectory()) await walk(join(dir, item.name), p + '/'); else seen.push(p); } }
    await walk(first.directory);
    expect(seen.sort()).toEqual([...first.manifest.files.map(f => f.path), 'release-manifest.json'].sort());
    for (const f of first.manifest.files) expect(sha256(await readFile(join(first.directory, f.path)))).toBe(f.sha256);
    for (const path of RUNTIME_FILES) expect(await readFile(join(first.directory, path))).toEqual(await readFile(join(root, path)));
    const manifest = JSON.stringify(first.manifest);
    expect(manifest).not.toContain(root); expect(manifest).not.toContain(fixture);
    expect(manifest).not.toMatch(/"(?:pid|port|credentials|timestamp)"/);
    expect(await readdir(first.directory)).not.toContain('node_modules');
  });
  it('creates a deterministic safe USTAR archive matching the payload manifest', async () => {
    const extracted = join(fixture, 'extracted'); await mkdir(extracted);
    execFileSync('tar', ['-xzf', first.artifact, '-C', extracted], { windowsHide: true });
    for (const f of first.manifest.files) expect(sha256(await readFile(join(extracted, f.path)))).toBe(f.sha256);
    const bytes = gunzipSync(await readFile(first.artifact)); const entries = new Map();
    for (let offset = 0; bytes[offset] !== 0; ) {
      const h = bytes.subarray(offset, offset + 512);
      const name = h.subarray(0, 100).toString().replace(/\0.*$/, '');
      const size = parseInt(h.subarray(124, 136).toString(), 8);
      expect(parseInt(h.subarray(136, 148).toString(), 8)).toBe(0);
      entries.set(name, bytes.subarray(offset + 512, offset + 512 + size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect([...entries.keys()].sort()).toEqual([...first.manifest.files.map(f => f.path), 'release-manifest.json'].sort());
    for (const f of first.manifest.files) expect(sha256(entries.get(f.path))).toBe(f.sha256);
    expect(() => releaseArchive(new Map([['../escape', Buffer.from('x')]]))).toThrow('Unsafe');
  });
  it('loads GUI and boots Core outside the repo while actively forbidding external module resolution', async () => {
    const guard = join(fixture, 'guard.cjs');
    const allowed = first.directory;
    await writeFile(guard, `const M=require('node:module'),p=require('node:path');const original=M._resolveFilename;M._resolveFilename=function(...args){const found=original.apply(this,args);if(!M.isBuiltin(found)&&!p.resolve(found).startsWith(${JSON.stringify(allowed + '/')}.replaceAll('/',p.sep)))throw Error('External CJS module blocked: '+found);return found;};`);
    const loader = join(fixture, 'guard.mjs');
    await writeFile(loader, `import{pathToFileURL}from'node:url';const allowed=pathToFileURL(${JSON.stringify(allowed + '/')}).href;export async function resolve(s,c,next){const r=await next(s,c);if(!r.url.startsWith('node:')&&!r.url.startsWith(allowed))throw Error('External ESM module blocked: '+r.url);return r;}`);
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const flags = ['--require', guard, '--experimental-loader', pathToFileURL(loader).href];
    execFileSync(process.execPath, [...flags, '--input-type=module', '-e', "await import('./scripts/host-breakglass-gui-runtime.mjs')"], { cwd: allowed, env, windowsHide: true, stdio: 'pipe' });
    // Negative control: the very dependency that previously leaked from repo resolution is rejected.
    expect(() => execFileSync(process.execPath, [...flags, '--input-type=module', '-e', `await import(${JSON.stringify(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js', import.meta.url).href)})`], { cwd: allowed, env, windowsHide: true, stdio: 'pipe' })).toThrow(/External ESM module blocked/);
    const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
    const config = join(fixture, 'config.json'); await writeFile(config, JSON.stringify({ enabled: true, mode: 'safe', roots: [{ id: 'fixture', root: fixture }], computer_use: { enabled: true, server_url: 'http://127.0.0.1:1/mcp' }, audit_path: join(fixture, 'audit.jsonl') }));
    core = spawn(process.execPath, [...flags, 'dist/host-breakglass/server.js'], { cwd: allowed, env: { ...env, GPT_HOST_BREAKGLASS_CONFIG: config, GPT_HOST_BREAKGLASS_HOST: '127.0.0.1', GPT_HOST_BREAKGLASS_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; core.stderr.on('data', b => stderr += b); core.stdout.resume();
    let health;
    for (let i = 0; i < 100; i++) { if (core.exitCode !== null) throw Error(stderr); try { health = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) })).json(); break; } catch { await sleep(50); } }
    expect(health).toMatchObject({ ok: true, mode: 'safe', tool_count: 39 });
    const exited = once(core, 'exit'); core.kill(); await exited;
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  }, 20000);
});
