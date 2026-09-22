/* global process, console, Buffer */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build, version as esbuildVersion } from 'esbuild';

export const RUNTIME_FILES = [
  'connect-host-breakglass-openai.mjs', 'host-breakglass-computer-use.mjs',
  'host-breakglass-config-watch.mjs', 'host-breakglass-doctor.mjs', 'host-breakglass-gui-child.mjs',
  'host-breakglass-supervisor.mjs', 'host-breakglass-tunnel-discovery.mjs',
  'host-breakglass-tunnel-job.cs', 'host-breakglass-tunnel-job.ps1',
  'host-breakglass-tunnel-owner.mjs', 'host-breakglass-tunnel-runtime.mjs',
  'tunnel-poll-health.mjs', 'tunnel-readiness-watchdog.mjs'
].map(name => 'scripts/' + name);
const GUI = 'scripts/host-breakglass-gui-runtime.mjs';
const LIVENESS = 'scripts/host-breakglass-core-liveness.mjs';
const CORE = 'dist/host-breakglass/server.js';
const BUILDER = 'scripts/build-host-breakglass-release.mjs';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(String(bytes).replace(/^\uFEFF/, ''));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

export function checkoutIdentity(root, preview = false) {
  const clean = git(root, 'status', '--porcelain=v1', '--untracked-files=all') === '';
  if (!clean && !preview) throw Error('Release requires a CLEAN checkout; use --preview only for uncommitted review evidence.');
  return { commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), clean };
}

export async function bundleRuntime(root, entry) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], outfile: entry, write: false,
    bundle: true, packages: 'bundle', platform: 'node', format: 'esm', target: 'node20',
    metafile: true, sourcemap: false, legalComments: 'inline', charset: 'utf8',
    // Bundled CommonJS dependencies may require Node builtins at runtime.
    banner: { js: "import { createRequire as __releaseCreateRequire } from 'node:module'; const require = __releaseCreateRequire(import.meta.url);" }
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !isBuiltin(imported.path)) throw Error('Unexpected external package: ' + imported.path);
    }
  }
  const inputs = [];
  for (const path of Object.keys(result.metafile.inputs).sort()) {
    const rel = relative(root, resolve(root, path)).replaceAll('\\', '/');
    if (rel.startsWith('../') || rel.includes(':')) throw Error('Bundle input outside checkout');
    inputs.push({ path: rel, sha256: sha256(await readFile(join(root, rel))) });
  }
  return { bytes: Buffer.from(result.outputFiles[0].contents), inputs };
}

// USTAR with sorted paths and fixed metadata: no wall clock, username or host paths.
export function releaseArchive(entries) {
  const parts = [];
  for (const [name, data] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..') || Buffer.byteLength(name) > 100) throw Error('Unsafe archive path');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export async function buildRelease({ root = repoRoot, out = join(root, '.cache', 'host-breakglass-releases'), preview = false } = {}) {
  root = resolve(root); out = resolve(out);
  const identity = checkoutIdentity(root, preview);
  const outputRelative = relative(root, out).replaceAll('\\', '/');
  if (!outputRelative || (!outputRelative.startsWith('../') && !outputRelative.includes(':') && !outputRelative.startsWith('.cache/'))) throw Error('Output must be outside the checkout or under .cache/');
  const lockBytes = await readFile(join(root, 'package-lock.json'));
  const lock = json(lockBytes);
  const pkg = json(await readFile(join(root, 'package.json')));
  const installedSdk = json(await readFile(join(root, 'node_modules/@modelcontextprotocol/sdk/package.json')));
  if (pkg.devDependencies.esbuild !== '0.27.7' || lock.packages[''].devDependencies.esbuild !== '0.27.7'
    || esbuildVersion !== '0.27.7' || lock.packages['node_modules/esbuild'].version !== esbuildVersion
    || installedSdk.version !== '1.29.0' || lock.packages['node_modules/@modelcontextprotocol/sdk'].version !== '1.29.0') throw Error('Unexpected build dependency versions');
  const sourcePaths = [...RUNTIME_FILES, GUI, LIVENESS, BUILDER, 'package.json', 'package-lock.json', 'LICENSE'];
  const source = new Map(await Promise.all(sourcePaths.map(async p => [p, await readFile(join(root, p))])));
  // Invoke the existing build script unchanged. No production runtime or task is touched.
  execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'], { cwd: root, stdio: 'pipe', windowsHide: true });
  const gui = await bundleRuntime(root, GUI);
  const liveness = await bundleRuntime(root, LIVENESS);
  const core = await bundleRuntime(root, CORE);
  const entries = new Map(RUNTIME_FILES.map(p => [p, source.get(p)]));
  entries.set(GUI, gui.bytes); entries.set(CORE, core.bytes);
  entries.set(LIVENESS, liveness.bytes);
  entries.set('LICENSE', source.get('LICENSE'));
  // Release contains no installer dependencies or development npm scripts.
  entries.set('package.json', Buffer.from(JSON.stringify({ name: 'host-breakglass-release', private: true, type: 'module', engines: { node: pkg.engines.node } }, null, 2) + '\n'));
  const manifest = {
    schema: 'host-breakglass-release.v1', builder_version: 1,
    kind: preview ? 'review-preview' : 'release', git: identity,
    node_requirement: pkg.engines.node, package_lock_sha256: sha256(lockBytes),
    sdk_version: installedSdk.version, bundler: { name: 'esbuild', version: esbuildVersion },
    builder_source_sha256: sha256(source.get(BUILDER)),
    gui: { source_sha256: sha256(source.get(GUI)), bundle_sha256: sha256(gui.bytes), inputs: gui.inputs },
    core_liveness: { source_sha256: sha256(source.get(LIVENESS)), bundle_sha256: sha256(liveness.bytes), inputs: liveness.inputs },
    core: { build_input_sha256: sha256(await readFile(join(root, CORE))), bundle_sha256: sha256(core.bytes), inputs: core.inputs },
    provisioned_host_dependencies: ['Node.js', 'Windows PowerShell', 'Computer-Use runtime', 'Secure MCP Tunnel runtime and its host prerequisites'],
    files: [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length }))
  };
  // Fence concurrent source/ref edits, including ignored build inputs actually consumed.
  if (JSON.stringify(checkoutIdentity(root, preview)) !== JSON.stringify(identity)) throw Error('Checkout identity changed during build');
  for (const [path, bytes] of source) if (sha256(await readFile(join(root, path))) !== sha256(bytes)) throw Error('Source changed during build');
  for (const input of [...gui.inputs, ...core.inputs, ...liveness.inputs]) if (sha256(await readFile(join(root, input.path))) !== input.sha256) throw Error('Bundle input changed during build');
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const name = `host-breakglass-${identity.commit.slice(0, 12)}${preview ? '-preview' : ''}-${sha256(manifestBytes).slice(0, 12)}`;
  entries.set('release-manifest.json', manifestBytes);
  await mkdir(out, { recursive: true });
  const staging = await mkdtemp(join(out, '.building-'));
  for (const [path, bytes] of entries) { await mkdir(dirname(join(staging, path)), { recursive: true }); await writeFile(join(staging, path), bytes, { flag: 'wx' }); }
  const archive = releaseArchive(entries);
  // Never overwrite an existing version or artifact.
  await mkdir(join(out, name));
  await rename(staging, join(out, name, 'runtime'));
  await writeFile(join(out, name, name + '.tar.gz'), archive, { flag: 'wx' });
  await writeFile(join(out, name, name + '.tar.gz.sha256'), sha256(archive) + '  ' + name + '.tar.gz\n', { flag: 'wx' });
  return { name, directory: join(out, name, 'runtime'), artifact: join(out, name, name + '.tar.gz'), sha256: sha256(archive), manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); let out; let preview = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--preview') preview = true;
    else if (args[i] === '--out' && args[i + 1]) out = resolve(args[++i]);
    else throw Error('Usage: node scripts/build-host-breakglass-release.mjs [--out DIRECTORY] [--preview]');
  }
  const result = await buildRelease({ out, preview });
  console.log(JSON.stringify({ ...result, manifest: { kind: result.manifest.kind, git: result.manifest.git } }, null, 2));
}
