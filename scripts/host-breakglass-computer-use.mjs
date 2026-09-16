/* global process, console */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computerUseLaunchSpec, createGuiRuntime } from './host-breakglass-gui-runtime.mjs';

const repoRoot = process.cwd();
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? repoRoot, 'gpt-repo-host-breakglass');
let gui;
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await gui?.stop();
  process.exit(code);
}
process.once('SIGINT', () => { void stop(0); });
process.once('SIGTERM', () => { void stop(0); });
const configPath = resolve(process.env.GPT_HOST_BREAKGLASS_CONFIG ?? 'config.host-breakglass.local.json');
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
const spec = computerUseLaunchSpec(config, process.env, repoRoot, stateDir);
if (!spec) throw new Error('computer_use.enabled is not true in host-breakglass config.');
if (!stopping) {
  gui = createGuiRuntime(spec, {
    backoffMs: [],
    onChild: (child) => { child.stdout?.resume(); child.stderr?.resume(); },
    onState: (state) => {
      console.log('Computer-Use ' + state.status + (state.reason ? ': ' + state.reason : ''));
      if (state.reason === 'retry_budget_exhausted' || state.reason === 'cleanup_unconfirmed') void stop(1);
    }
  });
  gui.start();
}
