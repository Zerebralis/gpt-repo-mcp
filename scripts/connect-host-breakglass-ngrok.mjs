/* global process, console, fetch, setTimeout, AbortSignal */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { createConnectorRuntime } from "./connector-runtime.mjs";

const repoRoot = process.cwd();
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? repoRoot, "gpt-repo-host-breakglass");
const envPath = process.env.GPT_HOST_BREAKGLASS_ENV ?? join(stateDir, "host.env");
const statePath = process.env.GPT_HOST_BREAKGLASS_STATE_PATH ?? join(stateDir, "connector-state.json");
const runtime = createConnectorRuntime();

await loadDotEnv(envPath);
const configPath = resolve(process.env.GPT_HOST_BREAKGLASS_CONFIG ?? "config.host-breakglass.local.json");
const port = boundedInt(process.env.GPT_HOST_BREAKGLASS_PORT ?? "8797", "GPT_HOST_BREAKGLASS_PORT", 1, 65535);
const webAddr = process.env.GPT_HOST_BREAKGLASS_NGROK_WEB_ADDR ?? "127.0.0.1:4040";
const pathToken = required("GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN");
if (pathToken.length < 32) throw new Error("GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN must be at least 32 characters.");
await access(configPath, constants.R_OK);
await access(resolve("dist/host-breakglass/server.js"), constants.R_OK);
await mkdir(stateDir, { recursive: true });

const server = spawn(process.execPath, ["dist/host-breakglass/server.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    GPT_HOST_BREAKGLASS_CONFIG: configPath,
    GPT_HOST_BREAKGLASS_HOST: "127.0.0.1",
    GPT_HOST_BREAKGLASS_PORT: String(port),
    GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN: pathToken
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
runtime.track(server, "host-breakglass");
await waitForHealth(port);

const tunnel = spawn("ngrok", ["http", String(port), "--log", "false"], {
  cwd: repoRoot,
  env: tunnelEnv(),
  stdio: "ignore",
  windowsHide: true
});
runtime.track(tunnel, "ngrok");

const publicOrigin = await waitForNgrok(webAddr, port);
const mcpUrl = `${publicOrigin.replace(/\/$/, "")}/t/${pathToken}/mcp`;
await writeFile(statePath, JSON.stringify({
  ok: true,
  updated_at: new Date().toISOString(),
  public_origin: publicOrigin,
  mcp_url: mcpUrl,
  local_port: port,
  mode: "ngrok"
}, null, 2), { encoding: "utf8", mode: 0o600 });

console.log(`Host breakglass transport ready (origin hash=${shortHash(publicOrigin)}).`);
console.log(`State written to ${statePath}. URL is intentionally not printed.`);

function shutdown(signal) {
  runtime.shutdown(signal, "Shutting down host breakglass and independent ngrok tunnel.");
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function loadDotEnv(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing host-breakglass env file: ${path}`);
    }
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
  return ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in ${envPath}`);
  return value;
}
function boundedInt(raw, name, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}.`);
  return value;
}
async function waitForHealth(localPort) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await delay(100);
  }
  throw new Error("Host breakglass did not become healthy before tunnel startup.");
}
async function waitForNgrok(addr, localPort) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${addr}/api/tunnels`, { signal: AbortSignal.timeout(700) });
      if (response.ok) {
        const payload = await response.json();
        const match = payload?.tunnels?.find((item) =>
          item?.proto === "https" && String(item?.config?.addr ?? "").includes(String(localPort))
        );
        if (match?.public_url) return match.public_url;
      }
    } catch {
      // Still starting.
    }
    await delay(150);
  }
  throw new Error(`ngrok did not publish port ${localPort}.`);
}
function tunnelEnv() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
function shortHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
