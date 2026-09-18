/* global fetch, process, setTimeout, clearTimeout */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const children = [];
const tempRoots = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Server may still be starting; retry within the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Host Breakglass fixture did not become healthy");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-breakglass-session-http-"));
  tempRoots.push(root);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    mode: "safe",
    full_host_access: false,
    roots: [{ id: "fixture", root, read: true, write: true, execute: true }],
    computer_use: { enabled: false, server_url: "http://127.0.0.1:3107/mcp" },
    audit_path: join(root, "audit.jsonl")
  }), "utf8");

  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/host-breakglass/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GPT_HOST_BREAKGLASS_CONFIG: configPath,
      GPT_HOST_BREAKGLASS_HOST: "127.0.0.1",
      GPT_HOST_BREAKGLASS_PORT: String(port),
      GPT_HOST_BREAKGLASS_MAX_SESSIONS: "10",
      GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET: "8",
      GPT_HOST_BREAKGLASS_SESSION_PRESSURE_HIGH_WATERMARK: "9",
      GPT_HOST_BREAKGLASS_SESSION_IDLE_TTL_MS: "10000",
      GPT_HOST_BREAKGLASS_SESSION_PRESSURE_IDLE_TTL_MS: "8000"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base + "/health");
  return { base };
}

describe("Host Breakglass Streamable HTTP session errors", () => {
  test("returns protocol-correct 404 for an unknown session id and 400 only when the id is missing", async () => {
    const { base } = await fixture();
    const request = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };
    const common = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream"
      },
      body: JSON.stringify(request)
    };

    const stalePost = await fetch(base + "/mcp", {
      ...common,
      headers: { ...common.headers, "mcp-session-id": "stale-session-for-regression" }
    });
    expect(stalePost.status).toBe(404);
    expect(await stalePost.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32001, message: "Session not found" }
    });

    const missingPost = await fetch(base + "/mcp", common);
    expect(missingPost.status).toBe(400);
    expect(await missingPost.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "Bad Request: missing MCP session id" }
    });

    const staleGet = await fetch(base + "/mcp", {
      headers: { "mcp-session-id": "stale-session-for-regression" }
    });
    expect(staleGet.status).toBe(404);
    expect(await staleGet.text()).toContain("Session not found");

    const missingGet = await fetch(base + "/mcp");
    expect(missingGet.status).toBe(400);

    const staleDelete = await fetch(base + "/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": "stale-session-for-regression" }
    });
    expect(staleDelete.status).toBe(404);

    const missingDelete = await fetch(base + "/mcp", { method: "DELETE" });
    expect(missingDelete.status).toBe(400);

    const health = await (await fetch(base + "/health")).json();
    expect(health.mcp_sessions.cumulative.unknown_session_misses).toBe(3);
  });
});
