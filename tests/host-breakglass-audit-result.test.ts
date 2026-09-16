import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { createHostBreakglassMcpServer } from "../src/host-breakglass/register.js";

const closers: Array<() => Promise<void>> = [];
const auditWarning = {
  audit: {
    ok: false,
    code: "HOST_BREAKGLASS_AUDIT_WRITE_FAILED",
    message: "Audit recording failed. The operation result is unchanged; do not repeat the operation solely because of this audit failure."
  }
};

async function fixture(auditFails: boolean) {
  const context = createHostBreakglassContext(HostBreakglassConfigSchema.parse({
    enabled: true,
    roots: [{ id: "test", root: process.cwd(), read: true, execute: true }]
  }));
  const audit = vi.spyOn(context.audit, "write");
  if (auditFails) audit.mockRejectedValue(new Error("private audit sink detail"));
  else audit.mockResolvedValue(undefined);
  const server = createHostBreakglassMcpServer(context);
  const client = new Client({ name: "audit-result-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closers.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    context, audit, client,
    call: async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
      await client.callTool({ name, arguments: args }) as CallToolResult
  };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

function expectAudit(result: CallToolResult, fails: boolean) {
  const notices = result.content.filter((block) => block.type === "text" && block.text.includes("HOST_BREAKGLASS_AUDIT_WRITE_FAILED"));
  expect(notices).toHaveLength(fails ? 1 : 0);
  if (fails) expect(notices[0]).toEqual({ type: "text", text: JSON.stringify(auditWarning) });
  expect(JSON.stringify(result)).not.toContain("private audit sink detail");
}

function firstJson(result: CallToolResult) {
  const block = result.content[0];
  if (block.type !== "text") throw new Error("Expected a text result");
  return JSON.parse(block.text);
}

describe.each([false, true])("Host Breakglass operation results (audit fails=%s)", (auditFails) => {
  it.each([false, true])("preserves native operation result, operation fails=%s", async (operationFails) => {
    const { context, audit, call } = await fixture(auditFails);
    vi.spyOn(context.paths, "resolve").mockResolvedValue({ path: process.cwd() });
    const job = { job_id: "test-job", executable: "mock", cwd: process.cwd(), status: "running" as const, started_at: "2026-01-01T00:00:00Z", stdout_tail: "", stderr_tail: "" };
    const operation = vi.spyOn(context.processes, "start").mockImplementation(() => {
      if (operationFails) throw new Error("original operation error");
      return job;
    });

    const result = await call("host_process_start", { executable: "mock", args: [], cwd: process.cwd() });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "host_process_start", ok: !operationFails }));
    expect(result.isError === true).toBe(operationFails);
    expect(firstJson(result)).toEqual(operationFails
      ? { ok: false, error: { code: "HOST_BREAKGLASS_ERROR", message: "original operation error", retryable: false } }
      : { ok: true, result: job });
    expect(result.content).toHaveLength(auditFails ? 2 : 1);
    expectAudit(result, auditFails);
  });

  it.each(["success", "tool_error", "exception"] as const)("preserves Computer-Use %s without replay", async (outcome) => {
    const { context, audit, call } = await fixture(auditFails);
    const downstream: CallToolResult = {
      content: [{ type: "text", text: "downstream result" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      structuredContent: { original: "preserved" },
      _meta: { source: "downstream" },
      ...(outcome === "tool_error" ? { isError: true } : {})
    };
    const operation = vi.spyOn(context.computerUse, "call").mockImplementation(async () => {
      if (outcome === "exception") throw new Error("original GUI error");
      return downstream;
    });

    const result = await call("host_computer_use_call", { tool: "screenshot", arguments: {} });

    expect(operation).toHaveBeenCalledExactlyOnceWith("screenshot", {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "host_computer_use_call", ok: outcome === "success" }));
    expect(result.isError === true).toBe(outcome !== "success");
    if (outcome === "exception") {
      expect(firstJson(result)).toEqual({ ok: false, error: { code: "HOST_BREAKGLASS_COMPUTER_USE_ERROR", message: "original GUI error", retryable: true } });
    } else {
      expect(result).toEqual({ ...downstream, content: [...downstream.content, ...(auditFails ? [{ type: "text", text: JSON.stringify(auditWarning) }] : [])] });
      expect(downstream.content).toHaveLength(2);
    }
    expectAudit(result, auditFails);
  });

  it.each(["success", "tool_error", "exception"] as const)("preserves window observation %s without replay", async (outcome) => {
    const { context, audit, call } = await fixture(auditFails);
    const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
    const operation = vi.spyOn(context.computerUse, "call").mockImplementation(async (tool) => {
      if (tool === "get_ui_tree" && outcome === "exception") throw new Error("original observation error");
      return { content: tool === "screenshot" ? [image] : [{ type: "text", text: tool }], ...(tool === "get_ui_tree" && outcome === "tool_error" ? { isError: true } : {}) };
    });

    const result = await call("host_window_observe", { window_id: 42 });

    expect(operation.mock.calls).toEqual([
      ["get_window", { window_id: 42 }],
      ["get_ui_tree", { window_id: 42, max_depth: 10 }],
      ...(outcome === "exception" ? [] : [["screenshot", { target_window_id: 42, quality: 80, provider: "openai" }]])
    ]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "host_window_observe", ok: outcome === "success" }));
    expect(result.isError === true).toBe(outcome !== "success");
    if (outcome === "exception") {
      expect(firstJson(result)).toEqual({ ok: false, error: { code: "HOST_BREAKGLASS_WINDOW_OBSERVE_ERROR", message: "original observation error", retryable: true } });
    } else {
      expect(result.content.slice(0, 7)).toEqual([
        { type: "text", text: JSON.stringify({ ok: true, window_id: 42, include_ui: true, include_screenshot: true }) },
        { type: "text", text: "--- window ---" }, { type: "text", text: "get_window" },
        { type: "text", text: "--- ui ---" }, { type: "text", text: "get_ui_tree" },
        { type: "text", text: "--- screenshot ---" }, image
      ]);
      expect(result.content).toHaveLength(auditFails ? 8 : 7);
    }
    expectAudit(result, auditFails);
  });
});

it("keeps the existing tool surface", async () => {
  const { client } = await fixture(false);
  expect((await client.listTools()).tools).toHaveLength(39);
});
