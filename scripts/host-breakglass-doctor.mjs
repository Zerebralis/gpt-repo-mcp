/* global process, console, setTimeout, clearTimeout, fetch, AbortSignal, URL */
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { probeTunnelPollHealth } from "./tunnel-poll-health.mjs";
import { readReadyTunnelDiscovery } from './host-breakglass-tunnel-discovery.mjs';

const coreOnly = process.argv.includes("--core-only");
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? process.cwd(), "gpt-repo-host-breakglass");
const envPath = process.env.GPT_HOST_BREAKGLASS_ENV ?? join(stateDir, "host.env");
const envValues = await readEnvFile(envPath);
const configPath = resolve(process.env.GPT_HOST_BREAKGLASS_CONFIG ?? envValues.GPT_HOST_BREAKGLASS_CONFIG ?? "config.host-breakglass.local.json");
const port = Number(process.env.GPT_HOST_BREAKGLASS_PORT ?? envValues.GPT_HOST_BREAKGLASS_PORT ?? 8797);
const tunnelClient = process.env.GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN
  ?? envValues.GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN
  ?? "C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe";
const tunnelPollStaleMs = Number(process.env.GPT_HOST_BREAKGLASS_TUNNEL_POLL_STALE_MS ?? envValues.GPT_HOST_BREAKGLASS_TUNNEL_POLL_STALE_MS ?? 180000);
const report = { ok: true, core_ok: true, gui_ready: true, transport_ready: true, config: configPath, checks: [] };
let hostConfig;

function check(scope, name, ok, detail) {
  report.checks.push({ scope, name, ok, detail });
  if (!ok && scope === "core") report.core_ok = false;
  if (!ok && scope === "gui") report.gui_ready = false;
  if (!ok && scope === "transport") report.transport_ready = false;
}

try {
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
  hostConfig = config;
  check("core", "config_enabled", config.enabled === true, config.enabled === true ? "enabled" : "disabled");
  check("core", "safe_or_full_mode", config.mode === "safe" || config.mode === "full", String(config.mode));
  check("core", "roots_present", Array.isArray(config.roots) && (config.roots.length > 0 || config.full_host_access === true), `${config.roots?.length ?? 0} configured`);
  for (const root of config.roots ?? []) {
    try {
      await access(root.root, constants.R_OK);
      if (root.write) await access(root.root, constants.W_OK);
      check("core", `root:${root.id}`, true, root.root);
    } catch (error) {
      check("core", `root:${root.id}`, false, error instanceof Error ? error.message : String(error));
    }
  }
} catch (error) {
  check("core", "config_load", false, error instanceof Error ? error.message : String(error));
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
check("core", "node", nodeMajor >= 20, process.version);
const git = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
check("core", "git", git.status === 0, (git.stdout || git.stderr).trim());
const portState = await probePort(port);
check("core", "port", true, portState);

if (hostConfig?.computer_use?.enabled === true) {
  const entry = process.env.GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY
    ?? envValues.GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY
    ?? "C:\\Tools\\computer-use-runtime\\node_modules\\@zavora-ai\\computer-use-mcp\\dist\\http.js";
  try {
    await access(entry, constants.R_OK);
    check("gui", "computer_use_runtime", true, "present");
  } catch {
    check("gui", "computer_use_runtime", false, "missing");
  }
  try {
    const target = new URL(hostConfig.computer_use.server_url);
    const response = await fetch(target, { method: "GET", signal: AbortSignal.timeout(2_000) });
    check("gui", "computer_use_loopback", response.status > 0, `reachable status=${response.status}`);
  } catch (error) {
    check("gui", "computer_use_loopback", false, error instanceof Error ? error.name : "unreachable");
  }
} else {
  check("gui", "computer_use", true, "disabled");
}

check("transport", "env_file", Object.keys(envValues).length > 0, Object.keys(envValues).length > 0 ? "present" : "missing");
check("transport", "tunnel_id", Boolean(envValues.CONTROL_PLANE_TUNNEL_ID?.trim() || process.env.CONTROL_PLANE_TUNNEL_ID?.trim()), "configured=" + Boolean(envValues.CONTROL_PLANE_TUNNEL_ID?.trim() || process.env.CONTROL_PLANE_TUNNEL_ID?.trim()));
check("transport", "runtime_api_key", Boolean(envValues.CONTROL_PLANE_API_KEY?.trim() || process.env.CONTROL_PLANE_API_KEY?.trim()), "configured=" + Boolean(envValues.CONTROL_PLANE_API_KEY?.trim() || process.env.CONTROL_PLANE_API_KEY?.trim()));
try {
  await access(tunnelClient, constants.R_OK);
  const version = spawnSync(tunnelClient, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  check("transport", "tunnel_client", version.status === 0, version.status === 0 ? version.stdout.trim() : "binary present but version check failed");
} catch {
  check("transport", "tunnel_client", false, "missing");
}
let tunnelHealthBase = null;
try {
  const state = await readReadyTunnelDiscovery(stateDir, process.env.GPT_HOST_BREAKGLASS_STATE_PATH ?? join(stateDir, 'connector-state.json'));
  tunnelHealthBase = state.health_base_url;
  const ready = await fetch(tunnelHealthBase + '/readyz', {signal: AbortSignal.timeout(2000)});
  if (!ready.ok) throw new Error('Tunnel readiness is unhealthy');
} catch (error) {
  tunnelHealthBase = null;
  check("transport", "control_plane_poll", false, error instanceof Error ? error.message : String(error));
}
if (tunnelHealthBase !== null) {
  try {
    const poll = await probeTunnelPollHealth(tunnelHealthBase, { staleMs: tunnelPollStaleMs, timeoutMs: 2_000 });
    const detail = poll.lastSuccessUnixSeconds > 0
      ? `${poll.status}; last_success=${new Date(poll.lastSuccessUnixSeconds * 1000).toISOString()}; age_ms=${poll.ageMs}`
      : poll.status;
    check("transport", "control_plane_poll", poll.fresh, detail);
  } catch (error) {
    check("transport", "control_plane_poll", false, error instanceof Error ? error.message : String(error));
  }
}
try {
  const response = await fetch("https://api.openai.com/", { method: "HEAD", signal: AbortSignal.timeout(4_000) });
  check("transport", "openai_https_443", true, `reachable status=${response.status}`);
} catch (error) {
  check("transport", "openai_https_443", false, error instanceof Error ? error.name : "unreachable");
}

report.ok = report.core_ok && report.gui_ready && (coreOnly || report.transport_ready);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

async function readEnvFile(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); } catch { return {}; }
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
async function probePort(targetPort) {
  return new Promise((done) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
    const timer = setTimeout(() => { socket.destroy(); done(`port ${targetPort} appears available`); }, 350);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); done(`port ${targetPort} is accepting connections`); });
    socket.once("error", () => { clearTimeout(timer); done(`port ${targetPort} appears available`); });
  });
}
