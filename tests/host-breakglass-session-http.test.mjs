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

async function fixture(overrides = {}) {
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
      GPT_HOST_BREAKGLASS_MAX_SESSIONS: String(overrides.maxSessions ?? 10),
      GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET: String(overrides.softTarget ?? 8),
      GPT_HOST_BREAKGLASS_SESSION_PRESSURE_HIGH_WATERMARK: String(overrides.highWatermark ?? 9),
      GPT_HOST_BREAKGLASS_SESSION_IDLE_TTL_MS: String(overrides.idleTtlMs ?? 10000),
      GPT_HOST_BREAKGLASS_SESSION_PRESSURE_IDLE_TTL_MS: String(overrides.pressureIdleTtlMs ?? 8000)
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base + "/health");
  return { base };
}

async function initializeSession(base, id) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "session-churn-test", version: "1" }
      }
    })
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await response.text();

  const initialized = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  });
  expect([200, 202]).toContain(initialized.status);
  await initialized.text();
  return sessionId;
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

  test("health exposes stable backend instance identity independently of MCP session churn", async () => {
    const { base } = await fixture();

    const before = await (await fetch(base + "/health")).json();
    expect(before).toMatchObject({
      ok: true,
      name: "gpt-repo-host-breakglass",
      tool_count: 42
    });
    expect(before.instance_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(typeof before.started_at).toBe("string");
    expect(before.mcp_sessions.active).toBe(0);

    await initializeSession(base, 41);
    const after = await (await fetch(base + "/health")).json();

    expect(after.instance_id).toBe(before.instance_id);
    expect(after.started_at).toBe(before.started_at);
    expect(after.mcp_sessions.active).toBe(1);
    expect(after.mcp_sessions.cumulative.committed).toBe(1);
  });

  test("cold reconnect burst uses emergency idle reclaim instead of hard-cap admission failure", async () => {
    const { base } = await fixture({
      maxSessions: 10,
      softTarget: 8,
      highWatermark: 9,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 8_000
    });

    const initial = [];
    for (let index = 0; index < 10; index += 1) {
      initial.push(await initializeSession(base, 500 + index));
    }

    let health = await (await fetch(base + "/health")).json();
    expect(health.mcp_sessions.active).toBe(10);
    expect(health.mcp_sessions.cumulative.pressure_reclaimed).toBe(0);
    expect(health.mcp_sessions.cumulative.admission_rejected).toBe(0);

    const extra = await initializeSession(base, 999);
    expect(extra).toBeTruthy();

    health = await (await fetch(base + "/health")).json();
    expect(health.mcp_sessions.active).toBeLessThanOrEqual(9);
    expect(health.mcp_sessions.cumulative.emergency_reclaimed).toBeGreaterThan(0);
    expect(health.mcp_sessions.cumulative.admission_rejected).toBe(0);

    const retiredReuse = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-session-id": initial[0]
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1000, method: "tools/list", params: {} })
    });
    expect(retiredReuse.status).toBe(404);

    health = await (await fetch(base + "/health")).json();
    expect(health.mcp_sessions.cumulative.emergency_reclaim_reuse_attempts).toBeGreaterThan(0);
    expect(health.mcp_sessions.cumulative.admission_rejected).toBe(0);
  });

  test("sustained churn reclaims old idle sessions before hard-cap saturation and stale reuse gets 404", async () => {
    const { base } = await fixture({
      maxSessions: 10,
      softTarget: 8,
      highWatermark: 9,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 1_000
    });

    const initial = [];
    for (let index = 0; index < 10; index += 1) {
      initial.push(await initializeSession(base, index + 1));
    }

    let health = await (await fetch(base + "/health")).json();
    expect(health.mcp_sessions.active).toBe(10);
    expect(health.mcp_sessions.cumulative.admission_rejected).toBe(0);

    for (let wave = 0; wave < 4; wave += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      for (let index = 0; index < 5; index += 1) {
        await initializeSession(base, 100 + wave * 10 + index);
      }
      health = await (await fetch(base + "/health")).json();
      expect(health.mcp_sessions.active).toBeLessThanOrEqual(10);
      expect(health.mcp_sessions.cumulative.admission_rejected).toBe(0);
    }

    expect(health.mcp_sessions.cumulative.pressure_reclaimed).toBeGreaterThan(0);
    expect(health.mcp_sessions.active).toBeLessThanOrEqual(9);

    const retiredReuse = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-session-id": initial[0]
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list", params: {} })
    });
    expect(retiredReuse.status).toBe(404);
    expect(await retiredReuse.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 999,
      error: { code: -32001, message: "Session not found" }
    });

    health = await (await fetch(base + "/health")).json();
    expect(health.mcp_sessions.cumulative.pressure_reclaim_reuse_attempts).toBeGreaterThan(0);
    expect(health.mcp_sessions.cumulative.admission_rejected).toBe(0);
  }, 15_000);
});
