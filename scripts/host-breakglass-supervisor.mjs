/* global process, console, setTimeout */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { computerUseLaunchSpec, createGuiRuntime } from "./host-breakglass-gui-runtime.mjs";
import { expectedHostPolicy, fingerprintHostConfiguration, waitForValidatedConfigurationChange } from "./host-breakglass-config-watch.mjs";

const repoRoot = resolve(process.env.GPT_HOST_BREAKGLASS_REPO_ROOT ?? process.cwd());
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? repoRoot, "gpt-repo-host-breakglass");
const statePath = join(stateDir, "supervisor-state.json");
const logPath = join(stateDir, "supervisor.log");
const connectorPath = join(repoRoot, "scripts", "connect-host-breakglass-openai.mjs");
const backoffMs = [2_000, 5_000, 15_000, 30_000, 60_000];
const children = new Map();
let stopping = false;
let restarts = 0;
let gui;
let supervisorState = {};
let stateWrites = Promise.resolve();

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await mkdir(stateDir, { recursive: true });
await rotateLogIfNeeded();
if (!stopping) {
  await writeState({ status: "starting" });
  log(`supervisor start pid=${process.pid}`);
}

while (!stopping) {
  const preflight = await preflightConfig();
  if (stopping) break;
  if (!preflight.ok) {
    await writeState({ status: "blocked", reason: preflight.reason });
    log(`blocked: ${preflight.reason}`);
    await delay(60_000);
    continue;
  }

  const startedAt = Date.now();
  let controlledReload = false;
  try {
    if (!gui) {
      gui = createGuiRuntime(preflight.guiSpec, {
        onChild: (child) => { pipeToLog(child.stdout, "computer-use"); pipeToLog(child.stderr, "computer-use"); },
        onState: (state) => {
          if (stopping) return;
          log(`computer-use ${state.status} attempt=${state.attempts} reason=${state.reason ?? "none"}`);
          void writeState({ gui: state, computer_use_pid: state.pid }).catch(() => log("GUI state write failed"));
        }
      });
      gui.start(); // Optional GUI never gates connector startup or shares its retry cycle.
    }

    const connector = startChild("connector", connectorPath, preflight.env);
    await writeState({
      status: "running",
      restart_count: restarts,
      connector_pid: connector.pid ?? null,
      computer_use_pid: gui.state().pid,
      active_policy: preflight.expectedPolicy,
      config_reload: { status: "watching" }
    });

    const watchAbort = new AbortController();
    const configWatch = waitForValidatedConfigurationChange({
      expectedFingerprint: preflight.fingerprint,
      readPreflight: preflightConfig,
      validateCandidate: validateCoreConfig,
      signal: watchAbort.signal,
      onBlocked: async (reason) => {
        log(`config reload blocked: ${reason}`);
        await writeState({ config_reload: { status: "blocked", reason } });
      },
      onRecovered: async () => {
        log("config reload candidate valid again");
        await writeState({ config_reload: { status: "watching" } });
      }
    });
    const ended = await Promise.race([
      ...[...children.entries()].map(([label, child]) => waitForExit(child).then((result) => ({ kind: "child", label, ...result }))),
      configWatch.then((result) => ({ kind: "config", ...result }))
    ]);
    watchAbort.abort();
    await configWatch.catch(() => undefined);
    if (stopping) break;
    if (ended.kind === "config" && ended.changed) {
      controlledReload = true;
      log("validated configuration change detected; recycling connector/core");
      await writeState({
        status: "reloading",
        restart_count: restarts,
        restart_in_ms: 0,
        reason: "configuration_changed",
        config_reload: { status: "applying" }
      });
    } else {
      log(`${ended.label} exit code=${ended.code ?? "null"} signal=${ended.signal ?? "null"}`);
    }
  } catch (error) {
    if (!stopping) log(`cycle failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await stopChildren();
  }

  if (stopping) break;
  if (controlledReload) {
    if (gui) {
      await gui.stop();
      gui = undefined;
    }
    await writeState({
      status: "restarting",
      restart_count: restarts,
      restart_in_ms: 0,
      reason: "configuration_changed",
      computer_use_pid: null,
      config_reload: { status: "applying" }
    });
    continue;
  }
  const runtimeMs = Date.now() - startedAt;
  if (runtimeMs > 5 * 60_000) restarts = 0;
  else restarts += 1;
  const backoff = backoffMs[Math.min(Math.max(restarts - 1, 0), backoffMs.length - 1)];
  await writeState({ status: "restarting", restart_count: restarts, restart_in_ms: backoff });
  log(`restart in ${backoff}ms`);
  await delay(backoff);
}

async function preflightConfig() {
  const envPath = resolve(process.env.GPT_HOST_BREAKGLASS_ENV ?? join(stateDir, "host.env"));
  let raw;
  try { raw = await readFile(envPath, "utf8"); }
  catch { return { ok: false, reason: "host.env missing" }; }
  const values = parseEnv(raw);
  for (const name of ["CONTROL_PLANE_TUNNEL_ID", "CONTROL_PLANE_API_KEY"]) {
    if (!values[name]?.trim()) return { ok: false, reason: `${name} missing` };
  }
  // Tunnel binary availability belongs to the connector-local tunnel generation.

  const configPath = resolve(values.GPT_HOST_BREAKGLASS_CONFIG?.trim() || join(repoRoot, "config.host-breakglass.local.json"));
  let configRaw, config;
  try {
    configRaw = await readFile(configPath, "utf8");
    config = JSON.parse(configRaw.replace(/^\uFEFF/, ""));
  }
  catch { return { ok: false, reason: "host-breakglass config missing or invalid" }; }

  let expectedPolicy;
  try {
    if (config.enabled !== true) throw new Error("Host Breakglass config is disabled");
    expectedPolicy = expectedHostPolicy(config);
    if (!Array.isArray(config.roots)) throw new Error("Host Breakglass roots must be an array");
    if (config.roots.length === 0 && !expectedPolicy.full_host_access) {
      throw new Error("Host Breakglass requires an approved root unless full_host_access=true");
    }
    for (const root of config.roots) {
      if (!root || typeof root.root !== "string" || !isAbsolute(root.root)) {
        throw new Error("Host Breakglass roots must use absolute paths");
      }
    }
  } catch {
    return { ok: false, reason: "host-breakglass config policy invalid" };
  }

  const env = { ...process.env, ...values, GPT_HOST_BREAKGLASS_CONFIG: configPath };
  let guiSpec;
  try { guiSpec = computerUseLaunchSpec(config, env, repoRoot, stateDir); }
  catch { return { ok: false, reason: "computer-use configuration invalid" }; }

  return {
    ok: true,
    env,
    guiSpec,
    expectedPolicy,
    configPath,
    fingerprint: fingerprintHostConfiguration({
      envPath,
      envRaw: raw,
      configPath,
      configRaw
    })
  };
}

async function validateCoreConfig(preflight) {
  const validatorPath = join(repoRoot, "dist", "host-breakglass", "server.js");
  return await new Promise((resolveValidation) => {
    execFile(process.execPath, [validatorPath, "--validate-config"], {
      cwd: repoRoot,
      env: {
        ...preflight.env,
        GPT_HOST_BREAKGLASS_CONFIG: preflight.configPath,
        GPT_HOST_BREAKGLASS_HOST: "127.0.0.1"
      },
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        resolveValidation({ ok: false, reason: "host-breakglass config schema invalid" });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result?.ok !== true ||
            result.mode !== preflight.expectedPolicy.mode ||
            result.full_host_access !== preflight.expectedPolicy.full_host_access) {
          resolveValidation({ ok: false, reason: "host-breakglass config validation mismatch" });
          return;
        }
        resolveValidation({ ok: true, preflight });
      } catch {
        resolveValidation({ ok: false, reason: "host-breakglass config validation response invalid" });
      }
    });
  });
}

function startChild(label, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.set(label, child);
  pipeToLog(child.stdout, label);
  pipeToLog(child.stderr, label);
  child.once("error", (error) => log(`${label} start error: ${error.message}`));
  return child;
}

async function stopChildren() {
  const live = [...children.values()].filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of live) child.kill("SIGTERM");
  await Promise.race([Promise.allSettled(live.map((child) => waitForExit(child))), delay(1_500)]);
  for (const child of live) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
}

function parseEnv(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("=");
    values[key] = unquote(parts.join("="));
  }
  return values;
}
function unquote(value) {
  const trimmed = value.trim();
  return ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed;
}
function waitForExit(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  return new Promise((resolveExit) => proc.once("exit", (code, signal) => resolveExit({ code, signal })));
}
function pipeToLog(stream, label) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) log(`${label}: ${line}`);
  });
  stream.on("end", () => { if (buffer.trim()) log(`${label}: ${buffer}`); });
}
async function writeState(extra) {
  supervisorState = extra.status
    ? { gui: supervisorState.gui, computer_use_pid: supervisorState.computer_use_pid, ...extra }
    : { ...supervisorState, ...extra };
  const safe = { schema: "gpt-host-breakglass-supervisor.v1", supervisor_pid: process.pid, updated_at: new Date().toISOString(), ...supervisorState };
  // GUI and connector report independently; serialize snapshots to prevent stale overwrites.
  stateWrites = stateWrites.catch(() => undefined).then(() => writeFile(statePath, JSON.stringify(safe, null, 2), { encoding: "utf8", mode: 0o600 }));
  await stateWrites;
}
function log(message) {
  const safe = String(message).replace(/https?:\/\/\S+/gi, "[URL]").replace(/tunnel_[A-Za-z0-9_-]+/g, "tunnel_[REDACTED]").replace(/(?:sk-|sess-|key-)[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]");
  void appendFile(logPath, `${new Date().toISOString()} ${safe}\n`, "utf8");
  console.log(safe);
}
async function rotateLogIfNeeded() {
  try {
    const info = await stat(logPath);
    if (info.size > 4 * 1024 * 1024) await writeFile(logPath, "", "utf8");
  } catch { /* no existing log */ }
}
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  const guiStopped = gui?.stop();
  log(`supervisor shutdown code=${code}`);
  void writeState({ status: "stopping" }).finally(async () => {
    await stopChildren();
    await guiStopped;
    process.exit(code);
  });
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
