import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { hostKillSystemProcess, protectedBreakglassRole } from "../src/host-breakglass/windows.js";

const windowsIt = process.platform === "win32" ? it : it.skip;
const cleanupPids = new Set<number>();

function testContext() {
  const config = HostBreakglassConfigSchema.parse({
    enabled: true,
    mode: "safe",
    roots: [{ id: "test", root: tmpdir(), read: true, write: true, execute: true }]
  });
  return createHostBreakglassContext(config);
}

async function spawnParentWithChild(): Promise<{ parent: ChildProcessWithoutNullStreams; childPid: number }> {
  const childCode = "setTimeout(() => process.exit(0), 60000)";
  const parentCode = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore', windowsHide: true, detached: true })`,
    "child.unref()",
    "process.stdout.write(String(child.pid) + '\\n')",
    "setTimeout(() => process.exit(0), 60000)"
  ].join("; ");
  const parent = spawn(process.execPath, ["-e", parentCode], { windowsHide: true });
  if (!parent.pid) throw new Error("Parent fixture did not receive a PID.");
  cleanupPids.add(parent.pid);
  const childPid = await readPid(parent);
  cleanupPids.add(childPid);
  return { parent, childPid };
}

async function readPid(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child PID.")), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split(/\r?\n/, 1)[0]?.trim();
      if (!line || !/^\d+$/.test(line)) return;
      clearTimeout(timer);
      resolve(Number(line));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (stdout.trim()) return;
      clearTimeout(timer);
      reject(new Error(`Fixture parent exited before reporting child PID (code ${code}).`));
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForState(pid: number, alive: boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (isAlive(pid) === alive) return;
    await delay(50);
  }
  throw new Error(`PID ${pid} did not reach alive=${alive}.`);
}

function cleanupPid(pid: number): void {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup of test-only fixture processes.
  }
}

afterEach(() => {
  for (const pid of cleanupPids) cleanupPid(pid);
  cleanupPids.clear();
});

describe("Host Breakglass Windows process termination", () => {
  it("classifies protected Breakglass stack components", () => {
    expect(protectedBreakglassRole({
      ProcessId: 10,
      ParentProcessId: 1,
      Name: "node.exe",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: "node C:\\Tools\\gpt-repo-mcp\\scripts\\host-breakglass-supervisor.mjs"
    })).toBe("Host Breakglass supervisor");

    expect(protectedBreakglassRole({
      ProcessId: 11,
      ParentProcessId: 10,
      Name: "node.exe",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: "node C:\\Tools\\computer-use-runtime\\node_modules\\@zavora-ai\\computer-use-mcp\\dist\\http.js"
    })).toBe("Computer-Use");

    expect(protectedBreakglassRole({
      ProcessId: 12,
      ParentProcessId: 10,
      Name: "node.exe",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: "node dist/host-breakglass/server.js"
    })).toBe("Host Breakglass server");

    expect(protectedBreakglassRole({
      ProcessId: 13,
      ParentProcessId: 10,
      Name: "tunnel-client.exe",
      ExecutablePath: "C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe",
      CommandLine: "C:\\Tools\\openai-tunnel-client\\v0.0.14\\tunnel-client.exe run"
    })).toBe("OpenAI tunnel-client");
  });

  windowsIt("kills only the requested parent PID by default and leaves its child running", async () => {
    const context = testContext();
    const { parent, childPid } = await spawnParentWithChild();
    const parentPid = parent.pid!;

    const result = await hostKillSystemProcess(context, { pid: parentPid });

    expect(result.exit_code).toBe(0);
    expect(result.tree).toBe(false);
    await waitForState(parentPid, false);
    await waitForState(childPid, true);
    expect(isAlive(childPid)).toBe(true);
  });

  windowsIt("kills parent and child only when tree=true is explicit", async () => {
    const context = testContext();
    const { parent, childPid } = await spawnParentWithChild();
    const parentPid = parent.pid!;

    const result = await hostKillSystemProcess(context, { pid: parentPid, tree: true });

    expect(result.exit_code).toBe(0);
    expect(result.tree).toBe(true);
    await waitForState(parentPid, false);
    await waitForState(childPid, false);
  });

  windowsIt("refuses direct termination of a protected Host Breakglass component", async () => {
    const context = testContext();
    const marker = "C:\\Tools\\gpt-repo-mcp\\scripts\\host-breakglass-supervisor.mjs";
    const fixture = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)", marker], {
      stdio: "ignore",
      windowsHide: true
    });
    if (!fixture.pid) throw new Error("Protected fixture did not receive a PID.");
    cleanupPids.add(fixture.pid);

    await expect(hostKillSystemProcess(context, { pid: fixture.pid })).rejects.toThrow(/protected Host Breakglass supervisor/i);
    expect(isAlive(fixture.pid)).toBe(true);
  });
});
