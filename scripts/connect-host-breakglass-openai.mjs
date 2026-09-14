/* global process, console, fetch, setTimeout, AbortSignal */
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = process.cwd();
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? repoRoot, "gpt-repo-host-breakglass");
const envPath = process.env.GPT_HOST_BREAKGLASS_ENV ?? join(stateDir, "host.env");
const statePath = process.env.GPT_HOST_BREAKGLASS_STATE_PATH ?? join(stateDir, "connector-state.json");
const healthUrlFile = join(stateDir, "openai-tunnel-health.url");
const pidFile = join(stateDir, "openai-tunnel.pid");

await loadDotEnv(envPath);
const configPath = resolve(process.env.GPT_HOST_BREAKGLASS_CONFIG ?? "config.host-breakglass.local.json");
const port = boundedInt(process.env.GPT_HOST_BREAKGLASS_PORT ?? "8797", "GPT_HOST_BREAKGLASS_PORT", 1, 65535);
const tunnelClient = process.env.GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN?.trim()
  || "C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe";
const tunnelId = required("CONTROL_PLANE_TUNNEL_ID");
required("CONTROL_PLANE_API_KEY");
if (!/^tunnel_[a-zA-Z0-9_-]{8,}$/.test(tunnelId)) throw new Error("CONTROL_PLANE_TUNNEL_ID has an unexpected format.");

await access(configPath, constants.R_OK);
await access(resolve("dist/host-breakglass/server.js"), constants.R_OK);
await access(tunnelClient, constants.R_OK);
await mkdir(stateDir, { recursive: true });
await Promise.all([rm(healthUrlFile, { force: true }), rm(pidFile, { force: true })]);

const children = new Map();
let stopping = false;
let exitCode = 0;

const server = track(spawn(process.execPath, ["dist/host-breakglass/server.js"], {
  cwd: repoRoot,
  env: {
    ...minimalRuntimeEnv(),
    GPT_HOST_BREAKGLASS_CONFIG: configPath,
    GPT_HOST_BREAKGLASS_HOST: "127.0.0.1",
    GPT_HOST_BREAKGLASS_PORT: String(port)
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
}), "host-breakglass");

await waitForHostHealth(server, port);

const tunnel = track(spawn(tunnelClient, ["run"], {
  cwd: repoRoot,
  env: {
    ...minimalRuntimeEnv(),
    CONTROL_PLANE_TUNNEL_ID: tunnelId,
    CONTROL_PLANE_API_KEY: process.env.CONTROL_PLANE_API_KEY,
    ...(process.env.CONTROL_PLANE_ORGANIZATION_ID ? { CONTROL_PLANE_ORGANIZATION_ID: process.env.CONTROL_PLANE_ORGANIZATION_ID } : {}),
    MCP_SERVER_URL: `http://127.0.0.1:${port}/mcp`,
    MCP_STARTUP_WAIT_TIMEOUT: "10s",
    HEALTH_LISTEN_ADDR: "127.0.0.1:0",
    HEALTH_URL_FILE: healthUrlFile,
    PID_FILE: pidFile,
    LOG_LEVEL: process.env.GPT_HOST_BREAKGLASS_TUNNEL_LOG_LEVEL ?? "info",
    LOG_FORMAT: "json"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
}), "tunnel-client");

const healthBase = await waitForTunnelHealthFile(tunnel, healthUrlFile);
await waitForTunnelReady(tunnel, healthBase);
await writeFile(statePath, JSON.stringify({
  ok: true,
  ready: true,
  updated_at: new Date().toISOString(),
  local_port: port,
  mode: "openai-secure-tunnel",
  health_base_url: healthBase
}, null, 2), { encoding: "utf8", mode: 0o600 });
console.log("Host breakglass OpenAI Secure MCP Tunnel ready.");
console.log(`State written to ${statePath}. Tunnel ID and API key are intentionally not printed.`);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function track(child, label) {
  children.set(label, child);
  pipeSanitized(child.stdout, label);
  pipeSanitized(child.stderr, label);
  child.once("error", (error) => {
    if (stopping) return;
    console.error(`[${label}] failed to start: ${sanitize(error.message)}`);
    shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(label);
    if (stopping) return;
    console.error(`[${label}] exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
    shutdown(code ?? 1);
  });
  return child;
}

async function waitForHostHealth(child, localPort) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assertChildAlive(child, "host-breakglass");
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error("Host breakglass did not become healthy before tunnel startup.");
}

async function waitForTunnelHealthFile(child, path) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assertChildAlive(child, "tunnel-client");
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (/^http:\/\/127\.0\.0\.1:\d+$/.test(value)) return value;
    } catch { /* not written yet */ }
    await delay(100);
  }
  throw new Error("tunnel-client did not publish its local health URL.");
}

async function waitForTunnelReady(child, healthBase) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assertChildAlive(child, "tunnel-client");
    try {
      const response = await fetch(`${healthBase}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* control-plane setup may still be starting */ }
    await delay(250);
  }
  throw new Error("tunnel-client health endpoint did not become ready.");
}

function assertChildAlive(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before readiness.`);
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children.values()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children.values()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 1200).unref();
}

function pipeSanitized(stream, label) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`[${label}] ${sanitize(line)}`);
  });
  stream.on("end", () => { if (buffer.trim()) console.log(`[${label}] ${sanitize(buffer)}`); });
}

function sanitize(value) {
  return String(value)
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/tunnel_[a-zA-Z0-9_-]+/g, "tunnel_[REDACTED]")
    .replace(/(?:sk-|sess-|key-)[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]");
}

async function loadDotEnv(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`Missing host-breakglass env file: ${path}`);
    throw error;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("=");
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = unquote(parts.join("="));
  }
}

function unquote(value) {
  const trimmed = value.trim();
  return ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed;
}
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name} in ${envPath}`); return value; }
function boundedInt(raw, name, min, max) { const value = Number(raw); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}.`); return value; }
function minimalRuntimeEnv() {
  const env = {};
  for (const name of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","USERPROFILE","HOME","LOCALAPPDATA","APPDATA","PROGRAMDATA","TEMP","TMP","ProgramFiles","ProgramFiles(x86)","ProgramW6432"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }