import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runProcessWithTail } from "../services/process-exec.js";
import { nonDestructiveMutationAnnotations, readOnlyAnnotations, safeMutationAnnotations, writeAnnotations } from "../tools/annotations.js";
import type { HostBreakglassContext } from "./context.js";
import { hostApplyChanges } from "./change-pack.js";
import { hostFileHash, hostHttpProbe, hostReadMany } from "./diagnostics.js";
import { hostHttpRequest } from "./http-request.js";
import { hostListDirectory, hostReadFile, hostSearch, hostStat, hostWriteFile } from "./filesystem.js";
import { hostGit } from "./git.js";
import { assertShellCommandAllowed, minimalHostEnv } from "./shell-policy.js";
import { shortHash, type HostAuditEvent } from "./audit.js";
import { hostEventLogQuery, hostKillSystemProcess, hostNetworkListeners, hostPortOwner, hostRegistryRead, hostRegistryWrite, hostScheduledTaskControl, hostScheduledTaskGet, hostScheduledTaskList, hostServiceControl, hostServiceList, hostSystemInfo, hostSystemProcessDetail, hostSystemProcesses, hostSystemProcessTree } from "./windows.js";

const P = z.string().min(2);
const approval = z.string().max(100).optional();
const pos = z.number().int().positive();
const empty = {};
const sha256Value = z.string().regex(/^[a-fA-F0-9]{64}$/);
const changePackItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), path: P, content: z.string(), create_directories: z.boolean().default(false), expected_old_sha256: sha256Value.optional(), expected_missing: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("replace"), path: P, find: z.string().min(1), replace: z.string(), replace_all: z.boolean().default(false), expected_old_sha256: sha256Value.optional() }).strict()
]);
export const HOST_BREAKGLASS_TOOL_COUNT = 40;

async function assertExistingWorkingDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`Working directory does not exist: ${path}. The cwd is stale or was removed; refresh the repository/worktree path before retrying. Do not treat this as an executable-not-found failure.`);
    }
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${path}`);
}

export function buildHostShellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    const wrappedCommand = `${command}\nif ($?) { exit 0 }\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nexit 1`;
    return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", wrappedCommand] };
  }
  return { executable: "/bin/sh", args: ["-lc", command] };
}

export function registerHostBreakglassTools(server: McpServer, context: HostBreakglassContext): void {
  server.registerTool("host_list_roots", { title: "List host roots", description: "Canonical read-only attachment handshake. List roots and capabilities approved for breakglass use; a successful call proves Host Breakglass is reachable from the current chat/tool context.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_list_roots", async () => ({ mode: context.config.mode, full_host_access: context.config.full_host_access, roots: context.config.roots })));

  server.registerTool("host_stat", { title: "Host path status", description: "Read metadata for an approved absolute host path.", inputSchema: { path: P }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_stat", () => hostStat(context, args.path)));

  server.registerTool("host_read_file", { title: "Read host file", description: "Read a bounded UTF-8 byte range from an approved host file.", inputSchema: { path: P, offset: z.number().int().nonnegative().optional(), length: pos.optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_read_file", () => hostReadFile(context, args)));

  server.registerTool("host_read_many", { title: "Read many host files", description: "Read up to 20 approved host files in one bounded call to reduce tunnel round-trips.", inputSchema: { files: z.array(z.object({ path: P, offset: z.number().int().nonnegative().optional(), length: pos.optional() }).strict()).min(1).max(20), max_total_bytes: pos.max(4 * 1024 * 1024).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_read_many", () => hostReadMany(context, args)));

  server.registerTool("host_file_hash", { title: "Hash host file", description: "Compute SHA-256 or SHA-512 for an approved host file without loading it all into memory.", inputSchema: { path: P, algorithm: z.enum(["sha256", "sha512"]).default("sha256") }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_file_hash", () => hostFileHash(context, args)));

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

  server.registerTool("host_apply_changes", {
    title: "Apply host change pack",
    description: "Dry-run or apply up to 25 guarded text-file writes/replacements. All targets are preflighted first; partial apply failures trigger best-effort rollback.",
    inputSchema: { changes: z.array(changePackItem).min(1).max(25), dry_run: z.boolean().default(false) },
    annotations: writeAnnotations
  }, async (args) => executeTool(context, "host_apply_changes", () => hostApplyChanges(context, args), { target_kind: "change-pack" }));
  server.registerTool("host_list_directory", { title: "List host directory", description: "List entries in an approved host directory.", inputSchema: { path: P, include_hidden: z.boolean().default(false), limit: pos.max(5_000).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_list_directory", () => hostListDirectory(context, args)));

  server.registerTool("host_search", { title: "Search host files", description: "Search filenames or bounded file contents below an approved host root.", inputSchema: { path: P, pattern: z.string().min(1), type: z.enum(["files", "content"]).default("files"), literal: z.boolean().default(true), ignore_case: z.boolean().default(true), include_hidden: z.boolean().default(false) }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_search", () => hostSearch(context, args)));

  server.registerTool("host_shell", { title: "Run breakglass shell", description: "Run a bounded PowerShell or POSIX shell command with an approved working directory. Safe mode adds high-risk command guardrails; arbitrary shell execution is not a filesystem sandbox.", inputSchema: { command: z.string().min(1).max(32_000), cwd: P, timeout_ms: pos.optional(), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_shell", async () => {
    const resolved = await context.paths.resolve(args.cwd, "execute");
    await assertExistingWorkingDirectory(resolved.path);
    assertShellCommandAllowed(context.config, args.command, args.approval);
    const shell = buildHostShellInvocation(args.command);
    return runProcessWithTail({ executable: shell.executable, args: shell.args, cwd: resolved.path, env: minimalHostEnv(), timeout_ms: clampTimeout(context, args.timeout_ms), tail_bytes: context.config.limits.max_output_bytes });
  }, { root_id: rootForPath(context, args.cwd), command_hash: shortHash(args.command), target_kind: "shell" }));

  server.registerTool("host_process_start", { title: "Start host process", description: "Start a long-running process without shell interpolation and track it by job id.", inputSchema: { executable: z.string().min(1).max(1_000), args: z.array(z.string().max(16_000)).max(200).default([]), cwd: P, timeout_ms: pos.optional(), approval }, annotations: nonDestructiveMutationAnnotations }, async (args) => executeTool(context, "host_process_start", async () => {
    const resolved = await context.paths.resolve(args.cwd, "execute");
    await assertExistingWorkingDirectory(resolved.path);
    assertShellCommandAllowed(context.config, [args.executable, ...args.args].join(" "), args.approval);
    return context.processes.start({ executable: args.executable, args: args.args, cwd: resolved.path, timeout_ms: args.timeout_ms ? clampTimeout(context, args.timeout_ms) : undefined });
  }, { root_id: rootForPath(context, args.cwd), command_hash: shortHash([args.executable, ...args.args].join("\u0000")), target_kind: "process" }));

  server.registerTool("host_process_output", { title: "Read process output", description: "Read current state and bounded output tail of a managed job.", inputSchema: { job_id: z.string().uuid() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_process_output", async () => context.processes.output(args.job_id)));
  server.registerTool("host_process_input", { title: "Write process input", description: "Write bounded UTF-8 input to stdin of a running managed process; optionally close stdin. This is line-oriented process input, not a full PTY.", inputSchema: { job_id: z.string().uuid(), chars: z.string().max(100_000).default(""), end: z.boolean().default(false) }, annotations: nonDestructiveMutationAnnotations }, async (args) => executeTool(context, "host_process_input", async () => context.processes.input(args.job_id, args.chars, args.end), { target_kind: "process-input" }));
  server.registerTool("host_process_list", { title: "List managed processes", description: "List processes started by this breakglass server.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_process_list", async () => context.processes.list()));
  server.registerTool("host_process_kill", { title: "Stop managed process", description: "Stop a process previously started by this breakglass server.", inputSchema: { job_id: z.string().uuid() }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_process_kill", async () => context.processes.kill(args.job_id)));

  server.registerTool("host_git", { title: "Host Git", description: "Run bounded Git status/diff/log/branch/add/commit/fetch/fast-forward pull/push/merge inside an approved root.", inputSchema: { cwd: P, operation: z.enum(["status", "diff", "log", "branch", "add", "commit", "fetch", "pull", "push", "merge"]), paths: z.array(z.string().min(1)).max(500).optional(), message: z.string().max(500).optional(), remote: z.string().min(1).max(200).optional(), branch: z.string().min(1).max(300).optional(), ref: z.string().min(1).max(300).optional(), staged: z.boolean().default(false), expected_head: z.string().regex(/^[a-fA-F0-9]{40,64}$/).optional() }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_git", () => hostGit(context, args), { root_id: rootForPath(context, args.cwd), target_kind: `git:${args.operation}` }));

  server.registerTool("host_system_info", { title: "System info", description: "Read basic operating-system and runtime information.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_system_info", async () => hostSystemInfo()));
  server.registerTool("host_system_processes", { title: "List system processes", description: "List Windows processes plus jobs managed by this breakglass server.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_system_processes", () => hostSystemProcesses(context)));
  server.registerTool("host_system_process_detail", { title: "System process detail", description: "Read one Windows process with command line, creation identity hash, and Breakglass protection classification.", inputSchema: { pid: pos }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_system_process_detail", () => hostSystemProcessDetail(context, args.pid), { pid: args.pid, target_kind: "system-process-detail" }));
  server.registerTool("host_system_process_tree", { title: "System process tree", description: "Read a Windows process and all descendants with stable identity hashes.", inputSchema: { pid: pos }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_system_process_tree", () => hostSystemProcessTree(context, args.pid), { pid: args.pid, target_kind: "system-process-tree-read" }));
  server.registerTool("host_system_process_kill", { title: "Stop system process", description: "Terminate exactly one Windows process by default. Optional expected_identity_sha256 rejects PID reuse/drift; tree=true must be explicit. Critical and Host Breakglass stack processes are protected.", inputSchema: { pid: pos, tree: z.boolean().default(false), expected_identity_sha256: sha256Value.optional(), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_system_process_kill", () => hostKillSystemProcess(context, args), { pid: args.pid, target_kind: args.tree ? "system-process-tree" : "system-process" }));
  server.registerTool("host_network_listeners", { title: "Network listeners", description: "List bounded local TCP listeners and UDP endpoints with owning process IDs.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_network_listeners", () => hostNetworkListeners(context), { target_kind: "network-listeners" }));
  server.registerTool("host_port_owner", { title: "Port owner", description: "Resolve one local TCP/UDP port to listeners and owning process details.", inputSchema: { port: pos.max(65_535), protocol: z.enum(["TCP", "UDP"]).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_port_owner", () => hostPortOwner(context, args), { target_kind: `port:${args.port}` }));
  server.registerTool("host_http_probe", { title: "HTTP health probe", description: "Probe an HTTP endpoint with bounded response metadata/body. Safe mode is loopback-only; remote URLs require full-mode approval.", inputSchema: { url: z.string().url().max(4_000), method: z.enum(["HEAD", "GET"]).default("GET"), timeout_ms: pos.max(30_000).optional(), max_body_bytes: z.number().int().nonnegative().max(65_536).optional(), approval }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_http_probe", () => hostHttpProbe(context, args), { target_kind: "http-probe" }));
  server.registerTool("host_http_request", {
    title: "Credentialed HTTPS request",
    description: "Send a bounded GET/POST HTTPS API request using a host-side configured credential reference.",
    inputSchema: {
      method: z.enum(["GET", "POST"]).default("GET"),
      url: z.string().url().max(4_000),
      credential_ref: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      headers: z.record(z.string().min(1).max(200), z.string().max(8_192)).default({}),
      body: z.record(z.string(), z.unknown()).optional(),
      timeout_ms: pos.max(60_000).optional(),
      max_body_bytes: z.number().int().nonnegative().max(1024 * 1024).optional()
    },
    annotations: nonDestructiveMutationAnnotations
  }, async (args) => executeTool(context, "host_http_request", () => hostHttpRequest(context, args), { target_kind: "credentialed-https:" + new URL(args.url).hostname }));
  server.registerTool("host_task_list", { title: "List scheduled tasks", description: "List Windows Scheduled Tasks with bounded filtering.", inputSchema: { name_contains: z.string().max(300).optional(), limit: pos.max(1_000).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_task_list", () => hostScheduledTaskList(context, args), { target_kind: "scheduled-tasks" }));
  server.registerTool("host_task_get", { title: "Read scheduled task", description: "Read one Windows Scheduled Task, run status, actions, and triggers.", inputSchema: { name: z.string().min(1).max(300), path: z.string().max(300).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_task_get", () => hostScheduledTaskGet(context, args), { target_kind: `scheduled-task:${args.name}` }));
  server.registerTool("host_task_start", { title: "Start scheduled task", description: "Start an allowlisted Windows Scheduled Task, or use full-mode approval.", inputSchema: { name: z.string().min(1).max(300), path: z.string().max(300).optional(), approval }, annotations: safeMutationAnnotations }, async (args) => executeTool(context, "host_task_start", () => hostScheduledTaskControl(context, { action: "start", ...args }), { target_kind: `scheduled-task:${args.name}` }));
  server.registerTool("host_task_stop", { title: "Stop scheduled task", description: "Stop an allowlisted Windows Scheduled Task, or use full-mode approval.", inputSchema: { name: z.string().min(1).max(300), path: z.string().max(300).optional(), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_task_stop", () => hostScheduledTaskControl(context, { action: "stop", ...args }), { target_kind: `scheduled-task:${args.name}` }));
  server.registerTool("host_eventlog_query", { title: "Query Windows event log", description: "Read a bounded recent slice of a Windows event log with optional provider or event-id filtering.", inputSchema: { log_name: z.string().min(1).max(300).optional(), since_minutes: pos.max(10_080).optional(), max_events: pos.max(200).optional(), provider: z.string().max(300).optional(), event_id: z.number().int().nonnegative().max(65_535).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_eventlog_query", () => hostEventLogQuery(context, args), { target_kind: "eventlog" }));
  server.registerTool("host_diagnostics_batch", { title: "Diagnostics batch", description: "Run up to 16 approved read-only diagnostics in one MCP call to reduce tunnel round-trips and session pressure.", inputSchema: { operations: z.array(z.object({ tool: z.enum(["system_info", "system_processes", "system_process_detail", "system_process_tree", "network_listeners", "port_owner", "task_list", "task_get", "eventlog_query", "http_probe", "stat", "file_hash"]), args: z.record(z.string(), z.unknown()).default({}) }).strict()).min(1).max(16) }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_diagnostics_batch", () => executeDiagnosticsBatch(context, args.operations), { target_kind: "diagnostics-batch" }));

  server.registerTool("host_registry_read", { title: "Read registry", description: "Read a Windows registry key or value.", inputSchema: { key: z.string().min(1).max(1_000), value: z.string().max(500).optional() }, annotations: readOnlyAnnotations }, async (args) => executeTool(context, "host_registry_read", () => hostRegistryRead(context, args)));
  server.registerTool("host_registry_write", { title: "Write registry", description: "Set or delete a named Windows registry value; safe mode is limited to configured write hives.", inputSchema: { action: z.enum(["set", "delete"]), key: z.string().min(1).max(1_000), value: z.string().min(1).max(500), data: z.string().max(32_000).optional(), type: z.enum(["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD", "REG_QWORD", "REG_MULTI_SZ"]).optional(), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_registry_write", () => hostRegistryWrite(context, args), { target_kind: "registry" }));
  server.registerTool("host_service_list", { title: "List services", description: "List Windows services.", inputSchema: empty, annotations: readOnlyAnnotations }, async () => executeTool(context, "host_service_list", () => hostServiceList(context)));
  server.registerTool("host_service_start", { title: "Start service", description: "Start an allowlisted Windows service, or use full-mode approval.", inputSchema: { name: z.string().min(1).max(300), approval }, annotations: safeMutationAnnotations }, async (args) => executeTool(context, "host_service_start", () => hostServiceControl(context, { action: "start", ...args }), { target_kind: `service:${args.name}` }));
  server.registerTool("host_service_stop", { title: "Stop service", description: "Stop an allowlisted Windows service, or use full-mode approval.", inputSchema: { name: z.string().min(1).max(300), approval }, annotations: writeAnnotations }, async (args) => executeTool(context, "host_service_stop", () => hostServiceControl(context, { action: "stop", ...args }), { target_kind: `service:${args.name}` }));

  server.registerTool("host_computer_use_catalog", {
    title: "Computer-Use catalog",
    description: "List GUI/Desktop tools exposed by the loopback Computer-Use adapter and allowed by breakglass policy.",
    inputSchema: empty,
    annotations: readOnlyAnnotations
  }, async () => executeTool(context, "host_computer_use_catalog", () => context.computerUse.catalog(), { target_kind: "computer-use:catalog" }));

  server.registerTool("host_window_observe", {
    title: "Observe one window",
    description: "Observe one window through Computer-Use in a single call: window metadata, accessibility tree, and optional screenshot.",
    inputSchema: { window_id: z.number().int(), include_ui: z.boolean().default(true), include_screenshot: z.boolean().default(true), max_depth: pos.max(20).default(10), screenshot_quality: z.number().int().min(0).max(100).default(80) },
    annotations: readOnlyAnnotations
  }, async (args) => executeComputerUseObserve(context, args));
  server.registerTool("host_computer_use_call", {
    title: "Computer-Use call",
    description: "Call one approved GUI/Desktop Computer-Use tool through the local loopback adapter. Downstream MCP image content is preserved. Do not use Computer Use, Explorer, or other GUI actions as a fallback for failed repo/build/test/review process execution unless the operator explicitly requested GUI interaction or the task intrinsically requires GUI.",
    inputSchema: {
      tool: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+$/),
      arguments: z.record(z.string(), z.unknown()).default({})
    },
    annotations: writeAnnotations
  }, async (args) => executeComputerUseTool(context, args.tool, args.arguments));
}

type AuditMeta = { root_id?: string; target_kind?: string; command_hash?: string; pid?: number };

// Audit is a separate outcome: never replace an operation result or replay an
// operation because its audit record could not be written.
async function withAuditResult(context: HostBreakglassContext, event: HostAuditEvent, response: CallToolResult): Promise<CallToolResult> {
  try {
    await context.audit.write(event);
    return response;
  } catch {
    return {
      ...response,
      content: [...response.content, {
        type: "text",
        text: JSON.stringify({ audit: {
          ok: false,
          code: "HOST_BREAKGLASS_AUDIT_WRITE_FAILED",
          message: "Audit recording failed. The operation result is unchanged; do not repeat the operation solely because of this audit failure."
        } })
      }]
    };
  }
}

async function executeTool(context: HostBreakglassContext, action: string, operation: () => Promise<unknown>, meta: AuditMeta = {}): Promise<CallToolResult> {
  const started = Date.now();
  let response: CallToolResult;
  let detail: string | undefined;
  try {
    const result = await operation();
    response = { content: [{ type: "text", text: JSON.stringify({ ok: true, result }, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detail = error instanceof Error ? error.name : "error";
    response = { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "HOST_BREAKGLASS_ERROR", message, retryable: false } }, null, 2) }] };
  }
  return withAuditResult(context, { action, ok: response.isError !== true, duration_ms: Date.now() - started, ...meta, ...(detail ? { detail } : {}) }, response);
}

async function executeComputerUseTool(
  context: HostBreakglassContext,
  tool: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const started = Date.now();
  let response: CallToolResult;
  let detail: string | undefined;
  try {
    response = await context.computerUse.call(tool, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detail = error instanceof Error ? error.name : "error";
    response = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "HOST_BREAKGLASS_COMPUTER_USE_ERROR", message, retryable: true } }, null, 2) }]
    };
  }
  return withAuditResult(context, {
    action: "host_computer_use_call",
    ok: response.isError !== true,
    duration_ms: Date.now() - started,
    target_kind: `computer-use:${tool}`,
    ...(detail ? { detail } : {})
  }, response);
}

async function executeDiagnosticsBatch(
  context: HostBreakglassContext,
  operations: Array<{ tool: string; args: Record<string, unknown> }>
) {
  const results = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    try {
      let result: unknown;
      switch (operation.tool) {
        case "system_info":
          z.object({}).strict().parse(operation.args);
          result = hostSystemInfo();
          break;
        case "system_processes":
          z.object({}).strict().parse(operation.args);
          result = await hostSystemProcesses(context);
          break;
        case "system_process_detail": {
          const args = z.object({ pid: pos }).strict().parse(operation.args);
          result = await hostSystemProcessDetail(context, args.pid);
          break;
        }
        case "system_process_tree": {
          const args = z.object({ pid: pos }).strict().parse(operation.args);
          result = await hostSystemProcessTree(context, args.pid);
          break;
        }
        case "network_listeners":
          z.object({}).strict().parse(operation.args);
          result = await hostNetworkListeners(context);
          break;
        case "port_owner": {
          const args = z.object({ port: pos.max(65_535), protocol: z.enum(["TCP", "UDP"]).optional() }).strict().parse(operation.args);
          result = await hostPortOwner(context, args);
          break;
        }
        case "task_list": {
          const args = z.object({ name_contains: z.string().max(300).optional(), limit: pos.max(1_000).optional() }).strict().parse(operation.args);
          result = await hostScheduledTaskList(context, args);
          break;
        }
        case "task_get": {
          const args = z.object({ name: z.string().min(1).max(300), path: z.string().max(300).optional() }).strict().parse(operation.args);
          result = await hostScheduledTaskGet(context, args);
          break;
        }
        case "eventlog_query": {
          const args = z.object({ log_name: z.string().min(1).max(300).optional(), since_minutes: pos.max(10_080).optional(), max_events: pos.max(200).optional(), provider: z.string().max(300).optional(), event_id: z.number().int().nonnegative().max(65_535).optional() }).strict().parse(operation.args);
          result = await hostEventLogQuery(context, args);
          break;
        }
        case "http_probe": {
          const args = z.object({ url: z.string().url().max(4_000), method: z.enum(["HEAD", "GET"]).default("GET"), timeout_ms: pos.max(30_000).optional(), max_body_bytes: z.number().int().nonnegative().max(65_536).optional() }).strict().parse(operation.args);
          result = await hostHttpProbe(context, args);
          break;
        }
        case "stat": {
          const args = z.object({ path: P }).strict().parse(operation.args);
          result = await hostStat(context, args.path);
          break;
        }
        case "file_hash": {
          const args = z.object({ path: P, algorithm: z.enum(["sha256", "sha512"]).default("sha256") }).strict().parse(operation.args);
          result = await hostFileHash(context, args);
          break;
        }
        default:
          throw new Error(`Unsupported diagnostics batch operation: ${operation.tool}`);
      }
      results.push({ index, tool: operation.tool, ok: true, result });
    } catch (error) {
      results.push({ index, tool: operation.tool, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { operations: results, succeeded: results.filter((entry) => entry.ok).length, failed: results.filter((entry) => !entry.ok).length };
}

async function executeComputerUseObserve(
  context: HostBreakglassContext,
  args: { window_id: number; include_ui: boolean; include_screenshot: boolean; max_depth: number; screenshot_quality: number }
): Promise<CallToolResult> {
  const started = Date.now();
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify({ ok: true, window_id: args.window_id, include_ui: args.include_ui, include_screenshot: args.include_screenshot }) }];
  let failed = false;
  let response: CallToolResult;
  let detail: string | undefined;
  try {
    const calls: Array<{ label: string; result: CallToolResult }> = [];
    calls.push({ label: "window", result: await context.computerUse.call("get_window", { window_id: args.window_id }) });
    if (args.include_ui) calls.push({ label: "ui", result: await context.computerUse.call("get_ui_tree", { window_id: args.window_id, max_depth: args.max_depth }) });
    if (args.include_screenshot) calls.push({ label: "screenshot", result: await context.computerUse.call("screenshot", { target_window_id: args.window_id, quality: args.screenshot_quality, provider: "openai" }) });
    for (const call of calls) {
      if (call.result.isError) failed = true;
      content.push({ type: "text", text: `--- ${call.label} ---` });
      content.push(...call.result.content);
    }
    response = { content, ...(failed ? { isError: true } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detail = error instanceof Error ? error.name : "error";
    response = { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "HOST_BREAKGLASS_WINDOW_OBSERVE_ERROR", message, retryable: true } }, null, 2) }] };
  }
  return withAuditResult(context, {
    action: "host_window_observe",
    ok: response.isError !== true,
    duration_ms: Date.now() - started,
    target_kind: `computer-use:window:${args.window_id}`,
    ...(detail ? { detail } : {})
  }, response);
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
