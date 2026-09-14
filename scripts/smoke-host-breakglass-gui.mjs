/* global process, console, fetch, setTimeout, AbortSignal, URL */
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fixture = await mkdtemp(join(tmpdir(), "gpt-host-gui-smoke-"));
const guiPort = await freePort();
const hostPort = await freePort();
const configPath = join(fixture, "config.json");
const runtimeEntry = process.env.GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY
  ?? "C:\\Tools\\computer-use-runtime\\node_modules\\@zavora-ai\\computer-use-mcp\\dist\\http.js";
await writeFile(configPath, JSON.stringify({
  enabled: true,
  mode: "safe",
  roots: [{ id: "fixture", root: fixture, read: true, write: true, execute: true }],
  git: { allow_push: false, allow_merge: false, allowed_remotes: ["origin"] },
  registry: { write_hives: ["HKCU"] },
  services: { allowlist: [] },
  computer_use: { enabled: true, server_url: `http://127.0.0.1:${guiPort}/mcp` }
}, null, 2), "utf8");

let gui;
let host;
let client;
try {
  gui = spawn(process.execPath, ["scripts/host-breakglass-computer-use.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GPT_HOST_BREAKGLASS_CONFIG: configPath,
      GPT_HOST_BREAKGLASS_COMPUTER_USE_ENTRY: runtimeEntry,
      GPT_HOST_BREAKGLASS_COMPUTER_USE_PROFILE: "ax",
      GPT_HOST_BREAKGLASS_COMPUTER_USE_ACTIVE_PROFILE: "ax"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  await waitForHttp(gui, guiPort, "/mcp", 10_000);

  host = spawn(process.execPath, ["dist/host-breakglass/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GPT_HOST_BREAKGLASS_CONFIG: configPath,
      GPT_HOST_BREAKGLASS_HOST: "127.0.0.1",
      GPT_HOST_BREAKGLASS_PORT: String(hostPort)
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  await waitForHttp(host, hostPort, "/health", 10_000, true);

  client = new Client({ name: "host-breakglass-gui-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hostPort}/mcp`)));
  const listed = await client.listTools();
  assert(listed.tools.some((tool) => tool.name === "host_computer_use_call"), "GUI call tool missing");

  const catalog = parseEnvelope(await client.callTool({ name: "host_computer_use_catalog", arguments: {} }));
  const names = catalog.result.tools.map((tool) => tool.name);
  assert(names.includes("screenshot"), "screenshot missing from GUI catalog");
  assert(names.includes("mouse_move"), "mouse_move missing from GUI catalog");
  assert(!names.includes("read_clipboard"), "read_clipboard should be excluded by default");

  const shot = await client.callTool({ name: "host_computer_use_call", arguments: { tool: "screenshot", arguments: {} } });
  assert(!shot.isError, "screenshot returned an error");
  assert(shot.content?.some((item) => item.type === "image"), "screenshot image content was not preserved");

  const cursor = await client.callTool({ name: "host_computer_use_call", arguments: { tool: "cursor_position", arguments: {} } });
  assert(!cursor.isError, "cursor_position returned an error");
  const text = cursor.content?.find((item) => item.type === "text")?.text ?? "";
  const match = text.match(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
  assert(match, `cursor_position could not be parsed: ${text}`);
  const coordinate = [Number(match[1]), Number(match[2])];
  const move = await client.callTool({ name: "host_computer_use_call", arguments: { tool: "mouse_move", arguments: { coordinate } } });
  assert(!move.isError, "mouse_move returned an error");

  console.log(`Host breakglass GUI smoke PASS (catalog=${names.length}, screenshot=image, mouse_move=ok).`);
} finally {
  if (client) await client.close().catch(() => undefined);
  await stop(host);
  await stop(gui);
  await rm(fixture, { recursive: true, force: true });
}

function parseEnvelope(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  const parsed = text ? JSON.parse(text) : undefined;
  if (result.isError || !parsed?.ok) throw new Error(`Tool failed: ${text ?? JSON.stringify(result)}`);
  return parsed;
}
function assert(value, message) { if (!value) throw new Error(message); }
async function waitForHttp(child, port, path, timeoutMs, requireOk = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`child exited before ${path} became reachable`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "GET", signal: AbortSignal.timeout(400) });
      if (requireOk ? response.ok : response.status > 0) return;
    } catch { /* still starting */ }
    await delay(75);
  }
  throw new Error(`${path} did not become reachable on port ${port}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([once(child, "exit").then(() => true), delay(1_500).then(() => false)]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
function delay(ms) { return new Promise((done) => setTimeout(done, ms)); }