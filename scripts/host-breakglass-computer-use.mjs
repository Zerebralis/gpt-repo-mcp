/* global process, console, fetch, setTimeout, AbortSignal, URL */
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = process.cwd();
const stateDir = process.env.GPT_HOST_BREAKGLASS_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? repoRoot, "gpt-repo-host-breakglass");
const configPath = resolve(process.env.GPT_HOST_BREAKGLASS_CONFIG ?? "config.host-breakglass.local.json");
const runtimeEntry = process.env.GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY?.trim()
  || "C:\\Tools\\computer-use-runtime\\node_modules\\@zavora-ai\\computer-use-mcp\\dist\\http.js";
const raw = await readFile(configPath, "utf8");
const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
if (config?.computer_use?.enabled !== true) throw new Error("computer_use.enabled is not true in host-breakglass config.");
const target = new URL(config.computer_use.server_url);
assertLoopback(target);
await access(runtimeEntry, constants.R_OK);

const child = spawn(process.execPath, [runtimeEntry], {
  cwd: repoRoot,
  env: {
    ...minimalRuntimeEnv(),
    COMPUTER_USE_PROFILE: process.env.GPT_HOST_BREAKGLASS_COMPUTER_USE_PROFILE ?? "ax",
    COMPUTER_USE_ACTIVE_PROFILE: process.env.GPT_HOST_BREAKGLASS_COMPUTER_USE_ACTIVE_PROFILE ?? "ax",
    COMPUTER_USE_HTTP_HOST: "127.0.0.1",
    COMPUTER_USE_HTTP_PORT: target.port || "3107",
    COMPUTER_USE_FS_ROOTS: (config.roots ?? []).map((entry) => entry.root).join(","),
    COMPUTER_USE_AUDIT_LOG: join(stateDir, "computer-use-audit.jsonl")
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
pipe(child.stdout, "computer-use");
pipe(child.stderr, "computer-use");
child.once("error", (error) => {
  console.error(`[computer-use] failed to start: ${sanitize(error.message)}`);
  process.exitCode = 1;
});

await waitForMcp(target, child);
console.log(`Computer-Use breakglass runtime ready on ${target.hostname}:${target.port || "80"}.`);

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
const result = await new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
if (result.code !== 0 && result.code !== null) process.exitCode = result.code;

function shutdown(signal) {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
async function waitForMcp(url, proc) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error("Computer-Use exited before readiness.");
    try {
      const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(500) });
      if (response.status > 0) return;
    } catch { /* still starting */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Computer-Use did not become reachable on loopback.");
}
function assertLoopback(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host) || url.pathname.replace(/\/+$/, "") !== "/mcp") {
    throw new Error("Computer-Use runtime target must be loopback http://.../mcp.");
  }
}
function pipe(stream, label) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`[${label}] ${sanitize(line)}`);
  });
}
function sanitize(value) {
  return String(value).replace(/https?:\/\/\S+/gi, "[URL]").replace(/(?:sk-|sess-|key-)[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]");
}
function minimalRuntimeEnv() {
  const env = {};
  for (const name of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","USERPROFILE","HOME","LOCALAPPDATA","APPDATA","PROGRAMDATA","TEMP","TMP","ProgramFiles","ProgramFiles(x86)","ProgramW6432"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}