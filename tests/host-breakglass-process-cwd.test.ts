import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { createHostBreakglassMcpServer } from "../src/host-breakglass/register.js";

const closers: Array<() => Promise<void>> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function firstJson(result: CallToolResult) {
  const block = result.content[0];
  if (block.type !== "text") throw new Error("Expected a text result");
  return JSON.parse(block.text);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-breakglass-cwd-"));
  tempRoots.push(root);
  const context = createHostBreakglassContext(HostBreakglassConfigSchema.parse({
    enabled: true,
    roots: [{ id: "test", root, read: true, execute: true }]
  }));
  const server = createHostBreakglassMcpServer(context);
  const client = new Client({ name: "host-breakglass-cwd-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closers.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, context, client };
}

describe("Host Breakglass process cwd diagnostics", () => {
  it("rejects a stale/missing worktree cwd before starting a valid executable", async () => {
    const { root, context, client } = await fixture();
    const start = vi.spyOn(context.processes, "start");
    const missing = join(root, "poe-brain-issue16");

    const result = await client.callTool({
      name: "host_process_start",
      arguments: { executable: process.execPath, args: ["--version"], cwd: missing }
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(firstJson(result).error.message).toContain("Working directory does not exist");
    expect(firstJson(result).error.message).toContain("stale or was removed");
    expect(firstJson(result).error.message).toContain("Do not treat this as an executable-not-found failure");
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects host_shell with the same stale cwd diagnosis", async () => {
    const { root, client } = await fixture();
    const missing = join(root, "removed-worktree");

    const result = await client.callTool({
      name: "host_shell",
      arguments: { command: "Write-Output ok", cwd: missing }
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(firstJson(result).error.message).toContain("Working directory does not exist");
  });

  it("classifies ENOENT as executable-not-found when cwd still exists", async () => {
    const { root, client } = await fixture();

    const started = await client.callTool({
      name: "host_process_start",
      arguments: { executable: "definitely-not-a-real-breakglass-executable-9f42.exe", args: [], cwd: root }
    }) as CallToolResult;
    expect(started.isError).not.toBe(true);
    const jobId = firstJson(started).result.job_id as string;

    let view;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const output = await client.callTool({
        name: "host_process_output",
        arguments: { job_id: jobId }
      }) as CallToolResult;
      view = firstJson(output).result;
      if (view.status !== "running") break;
    }

    expect(view.status).toBe("failed");
    expect(view.stderr_tail).toContain("HOST_PROCESS_EXECUTABLE_NOT_FOUND");
    expect(view.stderr_tail).toContain("No missing cwd was observed when this spawn failure was classified");
    expect(view.stderr_tail).not.toContain("HOST_PROCESS_CWD_NOT_FOUND");
  });

  it("advertises repo-process failure as a stop/diagnosis boundary, not a GUI fallback", async () => {
    const { client } = await fixture();
    const instructions = client.getInstructions();
    expect(instructions).toContain("not permission to switch to Explorer or Computer Use");
    expect(instructions).toContain("refresh the repository/worktree path before retrying");

    const listed = await client.listTools();
    const computerUse = listed.tools.find((tool) => tool.name === "host_computer_use_call");
    expect(computerUse?.description).toContain("Do not use Computer Use, Explorer, or other GUI actions as a fallback");
  });
});
