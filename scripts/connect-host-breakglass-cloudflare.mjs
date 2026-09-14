/* global process, console, fetch, setTimeout, AbortSignal */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const repoRoot = process.cwd();
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? repoRoot, "gpt-repo-host-breakglass");
const envPath = process.env.GPT_HOST_BREAKGLASS_ENV ?? join(stateDir, "host.env");
const statePath = process.env.GPT_HOST_BREAKGLASS_STATE_PATH ?? join(stateDir, "connector-state.json");
await loadDotEnv(envPath);
const configPath = resolve(process.env.GPT_HOST_BREAKGLASS_CONFIG ?? "config.host-breakglass.local.json");
const port = boundedInt(process.env.GPT_HOST_BREAKGLASS_PORT ?? "8797", "GPT_HOST_BREAKGLASS_PORT", 1, 65535);
const pathToken = required("GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN");
if (pathToken.length < 32) throw new Error("GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN must be at least 32 characters.");
const cloudflared = process.env.GPT_HOST_BREAKGLASS_CLOUDFLARED_BIN?.trim()
  || (process.platform === "win32" ? "C:\\Tools\\cloudflared\\cloudflared.exe" : "cloudflared");
await access(configPath, constants.R_OK);
await access(resolve("dist/host-breakglass/server.js"), constants.R_OK);
await access(cloudflared, constants.X_OK).catch(async () => access(cloudflared, constants.R_OK));
await mkdir(stateDir, { recursive: true });

const children = new Set();
let stopping = false;
track(spawn(process.execPath, ["dist/host-breakglass/server.js"], {
  cwd: repoRoot,
  env: { ...process.env, GPT_HOST_BREAKGLASS_CONFIG: configPath, GPT_HOST_BREAKGLASS_HOST: "127.0.0.1", GPT_HOST_BREAKGLASS_PORT: String(port), GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN: pathToken },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true
}), "host-breakglass", true);
await waitForHealth(port);

let resolveOrigin;
let rejectOrigin;
const originPromise = new Promise((resolveValue, rejectValue) => { resolveOrigin = resolveValue; rejectOrigin = rejectValue; });
const tunnel = track(spawn(cloudflared, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${port}`], {
  cwd: repoRoot, env: minimalTunnelEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true
}), "cloudflared", false);
consumeTunnelOutput(tunnel.stdout);
consumeTunnelOutput(tunnel.stderr);
const publicOrigin = await Promise.race([originPromise, delay(20000).then(() => { throw new Error("cloudflared did not publish a quick-tunnel URL."); })]);
const mcpUrl = `${String(publicOrigin).replace(/\/$/, "")}/t/${pathToken}/mcp`;
await writeFile(statePath, JSON.stringify({ ok: true, updated_at: new Date().toISOString(), public_origin: publicOrigin, mcp_url: mcpUrl, local_port: port, mode: "cloudflare-quick" }, null, 2), { encoding: "utf8", mode: 0o600 });
console.log(`Host breakglass transport ready (origin hash=${shortHash(String(publicOrigin))}).`);
console.log(`State written to ${statePath}. URL and path token are intentionally not printed.`);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function track(child, label, echo) {
  children.add(child);
  if (echo) {
    pipeSanitized(child.stdout, label);
    pipeSanitized(child.stderr, label);
  }
  child.once("error", (error) => {
    if (label === "cloudflared") rejectOrigin?.(error);
    console.error(`[${label}] failed to start: ${error.message}`);
    shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    if (label === "cloudflared") rejectOrigin?.(new Error(`cloudflared exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
    console.error(`[${label}] exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
    shutdown(code ?? 1);
  });
  return child;
}
function consumeTunnelOutput(stream) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) inspectTunnelLine(line);
  });
  stream.on("end", () => { if (buffer) inspectTunnelLine(buffer); });
}
function inspectTunnelLine(line) {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match) resolveOrigin?.(match[0]);
  if (/\b(error|failed|ERR_)\b/i.test(line)) console.error(`[cloudflared] ${redactUrls(line)}`);
}
function pipeSanitized(stream, label) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`[${label}] ${redactUrls(line)}`);
  });
}
function redactUrls(value) { return value.replace(/https?:\/\/\S+/gi, "[URL]"); }
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); process.exit(code); }, 1200).unref();
}
async function waitForHealth(localPort) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error("Host breakglass did not become healthy before tunnel startup.");
}
async function loadDotEnv(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`Missing host-breakglass env file: ${path}`); throw error; }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("="); if (!key || process.env[key] !== undefined) continue; process.env[key] = unquote(parts.join("="));
  }
}
function unquote(value) { const trimmed = value.trim(); return ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed; }
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name} in ${envPath}`); return value; }
function boundedInt(raw, name, min, max) { const value = Number(raw); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}.`); return value; }
function minimalTunnelEnv() { const env = {}; for (const name of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","USERPROFILE","LOCALAPPDATA","APPDATA","TEMP","TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name]; return env; }
function shortHash(value) { return createHash("sha256").update(value).digest("hex").slice(0, 12); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }