import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runProcessWithTail } from "../services/process-exec.js";
import { nonDestructiveMutationAnnotations, readOnlyAnnotations, safeMutationAnnotations, writeAnnotations } from "../tools/annotations.js";
import type { HostBreakglassContext } from "./context.js";
import { hostListDirectory, hostReadFile, hostSearch, hostStat, hostWriteFile } from "./filesystem.js";
import { hostGit } from "./git.js";
import { assertShellCommandAllowed, minimalHostEnv } from "./shell-policy.js";
import { shortHash } from "./audit.js";
import { hostKillSystemProcess, hostRegistryRead, hostRegistryWrite, hostServiceControl, hostServiceList, hostSystemInfo, hostSystemProcesses } from "./windows.js";

const P = z.string().min(2);
const approval = z.string().max(100).optional();
const pos = z.number().int().positive();
const empty = {};

export function registerHostBreakglassTools(server: McpServer, context: HostBreakglassContext): void {
  server.registerTool("host_list_roots", { title: "List host roots", description: "List roots and capabilities approved for breakglass use.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_list_roots", async () => ({ mode: context.config.mode, full_host_access: context.config.full_host_access, roots: context.config.roots })));

  server.registerTool("host_stat", { title: "Host path status", description: "Read metadata for an approved absolute host path.", inputSchema: { path: P }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_stat", () => hostStat(context, args.path)));

  server.registerTool("host_read_file", { title: "Read host file", description: "Read a bounded UTF-8 byte range from an approved host file.", inputSchema: { path: P, offset: z.number().int().nonnegative().optional(), length: pos.optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_read_file", () => hostReadFile(context, args)));

  server.registerTool("host_write_file", { title: "Write host file", description: "Rewrite or append an approved host file; expected_sha256 provides stale-write protection.", inputSchema: { path: P, content: z.string(), mode: z.enum(["rewrite", "append"]).default("rewrite"), create_directories: z.boolean().default(false), expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_write_file", async () => { await assertExpectedFileHash(context, args.path, args.expected_sha256); return hostWriteFile(context, args); }, { root_id: rootForPath(context, args.path), target_kind: "file" }));

  server.registerTool("host_edit_file", { title: "Edit host file", description: "Replace exact text in an approved host file with optional stale-write protection.", inputSchema: { path: P, old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().default(false), expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_edit_file", async () => {
    const current = await hostReadFile(context, { path: args.path });
    if (current.truncated) throw new Error("File is larger than the configured read limit; exact edit refused.");
    assertHash(current.content, args.expected_sha256);
    const count = countOccurrences(current.content, args.old_text);
    if (count === 0) throw new Error("old_text was not found.");
    if (!args.replace_all && count !== 1) throw new Error(`old_text occurs ${count} times; provide a unique fragment or set replace_all=true.`);
    const content = args.replace_all ? current.content.split(args.old_text).join(args.new_text) : current.content.replace(args.old_text, args.new_text);
    return hostWriteFile(context, { path: args.path, content, mode: "rewrite" });
  }, { root_id: rootForPath(context, args.path), target_kind: "file" }));

  server.registerTool("host_list_directory", { title: "List host directory", description: "List entries in an approved host directory.", inputSchema: { path: P, include_hidden: z.boolean().default(false), limit: pos.max(5_000).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_list_directory", () => hostListDirectory(context, args)));

  server.registerTool("host_search", { title: "Search host files", description: "Search filenames or bounded file contents below an approved host root.", inputSchema: { path: P, pattern: z.string().min(1), type: z.enum(["files", "content"]).default("files"), literal: z.boolean().default(true), ignore_case: z.boolean().default(true), include_hidden: z.boolean().default(false) }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_search", () => hostSearch(context, args)));

  server.registerTool("host_shell", { title: "Run breakglass shell", description: "Run a bounded PowerShell or POSIX shell command with an approved working directory. Safe mode adds high-risk command guardrails; arbitrary shell execution is not a filesystem sandbox.", inputSchema: { command: z.string().min(1).max(32_000), cwd: P, timeout_ms: pos.optional(), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_shell", async () => {
    const resolved = await context.paths.resolve(args.cwd, "execute");
    assertShellCommandAllowed(context.config, args.command, args.approval);
    const shell = process.platform === "win32" ? { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", args.command] } : { executable: "/bin/sh", args: ["-lc", args.command] };
    return runProcessWithTail({ executable: shell.executable, args: shell.args, cwd: resolved.path, env: minimalHostEnv(), timeout_ms: clampTimeout(context, args.timeout_ms), tail_bytes: context.config.limits.max_output_bytes });
  }, { root_id: rootForPath(context, args.cwd), command_hash: shortHash(args.command), target_kind: "shell" }));

  server.registerTool("host_process_start", { title: "Start host process", description: "Start a long-running process without shell interpolation and track it by job id.", inputSchema: { executable: z.string().min(1).max(1_000), args: z.array(z.string().max(16_000)).max(200).default([]), cwd: P, timeout_ms: pos.optional(), approval }, annotations: nonDestructiveMutationAnnotations }, async (args) => executeTool(context, "host_process_start", async () => {
    const resolved = await context.paths.resolve(args.cwd, "execute");
    assertShellCommandAllowed(context.config, [args.executable, ...args.args].join(" "), args.approval);
    return context.processes.start({ executable: args.executable, args: args.args, cwd: resolved.path, timeout_ms: args.timeout_ms ? clampTimeout(context, args.timeout_ms) : undefined });
  }, { root_id: rootForPath(context, args.cwd), command_hash: shortHash([args.executable, ...args.args].join("\u0000")), target_kind: "process" }));

  server.registerTool("host_process_output", { title: "Read process output", description: "Read current state and bounded output tail of a managed job.", inputSchema: { job_id: z.string().uuid() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_process_output", async () => context.processes.output(args.job_id)));
  server.registerTool("host_process_list", { title: "List managed processes", description: "List processes started by this breakglass server.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_process_list", async () => context.processes.list()));
  server.registerTool("host_process_kill", { title: "Stop managed process", description: "Stop a process previously started by this breakglass server.", inputSchema: { job_id: z.string().uuid() }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_process_kill", async () => context.processes.kill(args.job_id)));

  server.registerTool("host_git", { title: "Host Git", description: "Run bounded Git status/diff/log/branch/add/commit/fetch/fast-forward pull/push/merge inside an approved root.", inputSchema: { cwd: P, operation: z.enum(["status", "diff", "log", "branch", "add", "commit", "fetch", "pull", "push", "merge"]), paths: z.array(z.string().min(1)).max(500).optional(), message: z.string().max(500).optional(), remote: z.string().min(1).max(200).optional(), branch: z.string().min(1).max(300).optional(), ref: z.string().min(1).max(300).optional(), staged: z.boolean().default(false), expected_head: z.string().regex(/^[a-fA-F0-9]{40,64}$/).optional() }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_git", () => hostGit(context, args), { root_id: rootForPath(context, args.cwd), target_kind: `git:${args.operation}` }));

  server.registerTool("host_system_info", { title: "System info", description: "Read basic operating-system and runtime information.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_system_info", async () => hostSystemInfo()));
  server.registerTool("host_system_processes", { title: "List system processes", description: "List Windows processes plus jobs managed by this breakglass server.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_system_processes", () => hostSystemProcesses(context)));
  server.registerTool("host_system_process_kill", { title: "Stop system process", description: "Terminate a Windows process; critical process names are protected in safe mode.", inputSchema: { pid: pos, approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_system_process_kill", () => hostKillSystemProcess(context, args), { pid: args.pid, target_kind: "system-process" }));

  server.registerTool("host_registry_read", { title: "Read registry", description: "Read a Windows registry key or value.", inputSchema: { key: z.string().min(1).max(1_000), value: z.string().max(500).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_registry_read", () => hostRegistryRead(context, args)));
  server.registerTool("host_registry_write", { title: "Write registry", description: "Set or delete a named Windows registry value; safe mode is limited to configured write hives.", inputSchema: { action: z.enum(["set", "delete"]), key: z.string().min(1).max(1_000), value: z.string().min(1).max(500), data: z.string().max(32_000).optional(), type: z.enum(["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD", "REG_QWORD", "REG_MULTI_SZ"]).optional(), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_registry_write", () => hostRegistryWrite(context, args), { target_kind: "registry" }));
  server.registerTool("host_service_list", { title: "List services", description: "List Windows services.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_service_list", () => hostServiceList(context)));
  server.registerTool("host_service_start", { title: "Start service", description: "Start an allowlisted Windows service, or use full-mode approval.", inputSchema: { name: z.string().min(1).max(300), approval }, annotations: safeMutationAnnotations }, async (args) => executeTool(context, "host_service_start", () => hostServiceControl(context, { action: "start", ...args }), { target_kind: `service:${args.name}` }));
  server.registerTool("host_service_stop", { title: "Stop service", description: "Stop an allowlisted Windows service, or use full-mode approval.", inputSchema: { name: z.string().min(1).max(300), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_service_stop", () => hostServiceControl(context, { action: "stop", ...args }), { target_kind: `service:${args.name}` }));
}

type AuditMeta = { root_id?: string; target_kind?: string; command_hash?: string; pid?: number };

async function executeTool(context: HostBreakglassContext, action: string, operation: () => Promise<unknown>, meta: AuditMeta = {}): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await operation();
    await context.audit.write({ action, ok: true, duration_ms: Date.now() - started, ...meta });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, result }, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.audit.write({ action, ok: false, duration_ms: Date.now() - started, ...meta, detail: error instanceof Error ? error.name : "error" });
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "HOST_BREAKGLASS_ERROR", message, retryable: false } }, null, 2) }] };
  }
}

async function assertExpectedFileHash(context: HostBreakglassContext, path: string, expectedHash: string | undefined): Promise<void> {
  if (!expectedHash) return;
  const current = await hostReadFile(context, { path });
  if (current.truncated) throw new Error("File is larger than the configured read limit; stale-write check refused.");
  assertHash(current.content, expectedHash);
}
function assertHash(content: string, expectedHash: string | undefined): void {
  if (!expectedHash) return;
  const actual = createHash("sha256").update(content, "utf8").digest("hex");
  if (actual.toLowerCase() !== expectedHash.toLowerCase()) throw new Error(`File changed. expected_sha256=${expectedHash} actual_sha256=${actual}`);
}
function countOccurrences(haystack: string, needle: string): number { let count = 0; let offset = 0; while (true) { const next = haystack.indexOf(needle, offset); if (next < 0) return count; count += 1; offset = next + needle.length; } }
function clampTimeout(context: HostBreakglassContext, requested?: number): number { return Math.min(requested ?? context.config.limits.default_timeout_ms, context.config.limits.max_timeout_ms); }
function rootForPath(context: HostBreakglassContext, path: string): string | undefined {
  const lower = path.toLowerCase();
  return context.config.roots.filter((entry) => lower === entry.root.toLowerCase() || lower.startsWith(`${entry.root.toLowerCase()}\\`) || lower.startsWith(`${entry.root.toLowerCase()}/`)).sort((a, b) => b.root.length - a.root.length)[0]?.id;
}
