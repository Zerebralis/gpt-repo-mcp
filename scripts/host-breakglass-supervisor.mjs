/* global process, console, setTimeout */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(process.env.GPT_HOST_BREAKGLASS_REPO_ROOT ?? process.cwd());
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? repoRoot, "gpt-repo-host-breakglass");
const statePath = join(stateDir, "supervisor-state.json");
const logPath = join(stateDir, "supervisor.log");
const connectorPath = join(repoRoot, "scripts", "connect-host-breakglass-openai.mjs");
const backoffMs = [2_000, 5_000, 15_000, 30_000, 60_000];
let child;
let stopping = false;
let restarts = 0;

await mkdir(stateDir, { recursive: true });
await rotateLogIfNeeded();
await writeState({ status: "starting" });
log(`supervisor start pid=${process.pid}`);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

while (!stopping) {
  const preflight = await preflightConfig();
  if (!preflight.ok) {
    await writeState({ status: "blocked", reason: preflight.reason });
    log(`blocked: ${preflight.reason}`);
    await delay(60_000);
    continue;
  }

  const startedAt = Date.now();
  child = spawn(process.execPath, [connectorPath], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const childPid = child.pid;
  await writeState({ status: "running", child_pid: childPid, restart_count: restarts });
  pipeToLog(child.stdout, "connector");
  pipeToLog(child.stderr, "connector");
  const result = await waitForExit(child);
  child = undefined;
  if (stopping) break;

  const runtimeMs = Date.now() - startedAt;
  if (runtimeMs > 5 * 60_000) restarts = 0;
  else restarts += 1;
  const backoff = backoffMs[Math.min(restarts - 1, backoffMs.length - 1)];
  log(`connector exit code=${result.code ?? "null"} signal=${result.signal ?? "null"} runtime_ms=${runtimeMs} restart_in_ms=${backoff}`);
  await writeState({ status: "restarting", child_pid: null, restart_count: restarts, last_exit_code: result.code, last_signal: result.signal, restart_in_ms: backoff });
  await delay(backoff);
}

async function preflightConfig() {
  const envPath = process.env.GPT_HOST_BREAKGLASS_ENV ?? join(stateDir, "host.env");
  let raw;
  try { raw = await readFile(envPath, "utf8"); }
  catch { return { ok: false, reason: "host.env missing" }; }
  const values = parseEnv(raw);
  const required = ["CONTROL_PLANE_TUNNEL_ID", "CONTROL_PLANE_API_KEY"];
  for (const name of required) if (!values[name]?.trim()) return { ok: false, reason: `${name} missing` };
  const binary = values.GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN?.trim() || "C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe";
  try { await stat(binary); }
  catch { return { ok: false, reason: "tunnel-client binary missing" }; }
  return { ok: true };
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
function waitForExit(proc) { return new Promise((resolveExit) => proc.once("exit", (code, signal) => resolveExit({ code, signal }))); }
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
  const safe = { schema: "gpt-host-breakglass-supervisor.v1", supervisor_pid: process.pid, updated_at: new Date().toISOString(), ...extra };
  await writeFile(statePath, JSON.stringify(safe, null, 2), { encoding: "utf8", mode: 0o600 });
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
  log(`supervisor shutdown code=${code}`);
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  void writeState({ status: "stopping", child_pid: child?.pid ?? null }).finally(() => setTimeout(() => process.exit(code), 1500).unref());
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }