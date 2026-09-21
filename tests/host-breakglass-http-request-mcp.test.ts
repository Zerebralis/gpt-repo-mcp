import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processExecMock = vi.hoisted(() => ({
  runProcessWithTail: vi.fn()
}));
vi.mock("../src/services/process-exec.js", () => processExecMock);

import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { createHostBreakglassMcpServer } from "../src/host-breakglass/register.js";

const ENV_NAME = "BREAKGLASS_TEST_HTTP_MCP_TOKEN";
const TEST_VALUE = "fixture-mcp-credential-value";
const ORIGINAL_SYSTEM_ROOT = process.env.SystemRoot;
const ORIGINAL_TEST_ENV = process.env[ENV_NAME];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  process.env.SystemRoot = ORIGINAL_SYSTEM_ROOT ?? "C:\\Windows";
  process.env[ENV_NAME] = "process-env-must-not-be-used";
  processExecMock.runProcessWithTail.mockReset();
  processExecMock.runProcessWithTail.mockResolvedValue({
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
    stdout_tail: "\r\n    " + ENV_NAME + "    REG_SZ    " + TEST_VALUE + "\r\n",
    stderr_tail: "",
    stdout_truncated: false,
    stderr_truncated: false
  });
});

afterEach(async () => {
  if (ORIGINAL_SYSTEM_ROOT === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = ORIGINAL_SYSTEM_ROOT;
  if (ORIGINAL_TEST_ENV === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = ORIGINAL_TEST_ENV;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("host_http_request MCP boundary", () => {
  it("keeps the credential value out of tool arguments, result, and audit records", async () => {
    const state = await mkdtemp(join(tmpdir(), "breakglass-http-mcp-"));
    const auditPath = join(state, "audit.jsonl");

    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer " + TEST_VALUE);
      return new Response(JSON.stringify({ echoed: TEST_VALUE }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    const context = createHostBreakglassContext(HostBreakglassConfigSchema.parse({
      enabled: true,
      roots: [{ id: "test", root: process.cwd(), read: true, execute: true }],
      audit_path: auditPath,
      http: {
        credentials: [{
          id: "test-api",
          source: "windows_user_env",
          name: ENV_NAME,
          scheme: "bearer",
          allowed_hosts: ["api.example.test"]
        }]
      }
    }));
    const server = createHostBreakglassMcpServer(context);
    const client = new Client({ name: "http-request-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
      await rm(state, { recursive: true, force: true });
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === "host_http_request");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool)).toContain("credential_ref");
    expect(JSON.stringify(tool)).not.toContain(TEST_VALUE);

    const toolArguments = {
      method: "POST",
      url: "https://api.example.test/v1/chat",
      credential_ref: "test-api",
      headers: { "content-type": "application/json" },
      body: { model: "unit-test", max_tokens: 4 }
    };
    expect(JSON.stringify(toolArguments)).not.toContain(TEST_VALUE);

    const result = await client.callTool({
      name: "host_http_request",
      arguments: toolArguments
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain(TEST_VALUE);
    expect(JSON.stringify(result)).toContain("[REDACTED]");

    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain("host_http_request");
    expect(audit).toContain("credentialed-https:api.example.test");
    expect(audit).not.toContain(TEST_VALUE);
    expect(audit).not.toContain(ENV_NAME);
  });
});
