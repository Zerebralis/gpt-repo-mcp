import { createHash } from "node:crypto";
import os from "node:os";
import { runProcessWithTail } from "../services/process-exec.js";
import type { HostBreakglassContext } from "./context.js";
import { minimalHostEnv } from "./shell-policy.js";

const PROTECTED_PROCESS_NAMES = new Set([
  "system", "registry", "idle", "smss.exe", "csrss.exe", "wininit.exe",
  "winlogon.exe", "services.exe", "lsass.exe", "svchost.exe"
]);

type WindowsProcessDetails = {
  ProcessId: number;
  ParentProcessId: number;
  Name?: string | null;
  ExecutablePath?: string | null;
  CommandLine?: string | null;
  CreationDate?: string | null;
};

const PROTECTED_BREAKGLASS_COMMAND_MARKERS = [
  "\\gpt-repo-mcp\\scripts\\host-breakglass-supervisor.mjs",
  "\\gpt-repo-mcp\\scripts\\host-breakglass-computer-use.mjs",
  "\\gpt-repo-mcp\\scripts\\host-breakglass-gui-child.mjs",
  "\\gpt-repo-mcp\\scripts\\connect-host-breakglass-openai.mjs",
  "dist\\host-breakglass\\server.js",
  "\\computer-use-runtime\\node_modules\\@zavora-ai\\computer-use-mcp\\dist\\http.js"
];

const PROTECTED_BREAKGLASS_EXECUTABLE_MARKERS = [
  "\\tools\\openai-tunnel-client\\"
];

export function hostSystemInfo() {
  return {
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpu_count: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    free_memory_bytes: os.freemem(),
    uptime_seconds: os.uptime(),
    node: process.version,
    pid: process.pid
  };
}

export async function hostSystemProcesses(context: HostBreakglassContext) {
  ensureWindows();
  const result = await runBounded(context, "tasklist", ["/FO", "CSV", "/NH"], 30_000);
  return {
    exit_code: result.exit_code,
    processes_csv: result.stdout_tail,
    stderr: result.stderr_tail,
    managed_jobs: context.processes.list()
  };
}
export async function hostSystemProcessDetail(context: HostBreakglassContext, pid: number) {
  ensureWindows();
  const details = await processDetails(context, pid);
  if (!details) throw new Error(`Process not found: ${pid}`);
  return { ...details, IdentitySha256: processIdentitySha256(details), ProtectedRole: protectedBreakglassRole(details) ?? null };
}

export async function hostSystemProcessTree(context: HostBreakglassContext, pid: number) {
  ensureWindows();
  const tree = await processTreeDetails(context, pid);
  if (tree.length === 0) throw new Error(`Process tree root not found: ${pid}`);
  return {
    root_pid: pid,
    processes: tree.map((details) => ({ ...details, IdentitySha256: processIdentitySha256(details), ProtectedRole: protectedBreakglassRole(details) ?? null }))
  };
}

export async function hostNetworkListeners(context: HostBreakglassContext) {
  ensureWindows();
  const script = [
    "$tcp = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object @{n='Protocol';e={'TCP'}},LocalAddress,LocalPort,OwningProcess,State)",
    "$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Select-Object @{n='Protocol';e={'UDP'}},LocalAddress,LocalPort,OwningProcess,@{n='State';e={'Listen'}})",
    "@($tcp + $udp | Sort-Object Protocol,LocalPort,OwningProcess | Select-Object -First 1000) | ConvertTo-Json -Compress"
  ].join("; ");
  const result = await runPowerShellJson(context, script, 30_000);
  return { listeners: asArray<Record<string, unknown>>(result), truncated: asArray<Record<string, unknown>>(result).length >= 1000 };
}

export async function hostPortOwner(context: HostBreakglassContext, input: { port: number; protocol?: "TCP" | "UDP" }) {
  ensureWindows();
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Port must be 1-65535.");
  const all = await hostNetworkListeners(context);
  const matches = all.listeners.filter((entry) => Number(entry.LocalPort) === input.port && (!input.protocol || String(entry.Protocol).toUpperCase() === input.protocol));
  const pids = [...new Set(matches.map((entry) => Number(entry.OwningProcess)).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const processes = [];
  for (const pid of pids) {
    const details = await processDetails(context, pid);
    if (details) processes.push({ ...details, IdentitySha256: processIdentitySha256(details), ProtectedRole: protectedBreakglassRole(details) ?? null });
  }
  return { port: input.port, protocol: input.protocol ?? null, listeners: matches, processes };
}

export async function hostScheduledTaskList(context: HostBreakglassContext, input: { name_contains?: string; limit?: number } = {}) {
  ensureWindows();
  const needle = input.name_contains?.trim().toLowerCase();
  const limit = Math.min(Math.max(1, input.limit ?? 250), 1000);
  const script = [
    "$tasks = @(Get-ScheduledTask -ErrorAction Stop | Select-Object TaskName,TaskPath,State,Author)",
    "$tasks | ConvertTo-Json -Compress"
  ].join("; ");
  const raw = asArray<Record<string, unknown>>(await runPowerShellJson(context, script, 30_000));
  const filtered = needle ? raw.filter((task) => `${task.TaskPath ?? ''}${task.TaskName ?? ''}`.toLowerCase().includes(needle)) : raw;
  return { tasks: filtered.slice(0, limit), total_matches: filtered.length, truncated: filtered.length > limit };
}

export async function hostScheduledTaskGet(context: HostBreakglassContext, input: { name: string; path?: string }) {
  ensureWindows();
  const fullName = normalizeTaskName(input.name, input.path);
  const script = [
    `$task = Get-ScheduledTask -TaskName ${psQuote(taskLeaf(fullName))} -TaskPath ${psQuote(taskPath(fullName))} -ErrorAction Stop`,
    "$info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue",
    "[pscustomobject]@{TaskName=$task.TaskName;TaskPath=$task.TaskPath;State=$task.State;Author=$task.Author;LastRunTime=$info.LastRunTime;LastTaskResult=$info.LastTaskResult;NextRunTime=$info.NextRunTime;NumberOfMissedRuns=$info.NumberOfMissedRuns;Actions=@($task.Actions | Select-Object Execute,Arguments,WorkingDirectory);Triggers=@($task.Triggers | Select-Object Enabled,StartBoundary,EndBoundary)} | ConvertTo-Json -Depth 5 -Compress"
  ].join("; ");
  return { task: await runPowerShellJson(context, script, 30_000), full_name: fullName };
}

export async function hostScheduledTaskControl(context: HostBreakglassContext, input: { action: "start" | "stop"; name: string; path?: string; approval?: string }) {
  ensureWindows();
  const fullName = normalizeTaskName(input.name, input.path);
  const allowed = context.config.scheduled_tasks.allowlist.map((name) => name.toLowerCase()).includes(fullName.toLowerCase());
  if (!allowed && !(context.config.mode === "full" && input.approval === "HOST_BREAKGLASS_FULL")) {
    throw new Error("Scheduled task is not in the configured allowlist.");
  }
  const verb = input.action === "start" ? "/Run" : "/End";
  const result = await runBounded(context, "schtasks.exe", [verb, "/TN", fullName], 30_000);
  return { action: input.action, full_name: fullName, ...result };
}

export async function hostEventLogQuery(
  context: HostBreakglassContext,
  input: { log_name?: string; since_minutes?: number; max_events?: number; provider?: string; event_id?: number }
) {
  ensureWindows();
  const logName = (input.log_name ?? "System").trim();
  if (!/^[A-Za-z0-9 ._\\/()-]+$/.test(logName)) throw new Error("Unsafe event log name.");
  const sinceMinutes = Math.min(Math.max(1, input.since_minutes ?? 60), 10_080);
  const maxEvents = Math.min(Math.max(1, input.max_events ?? 50), 200);
  const provider = input.provider?.trim();
  if (provider && provider.length > 300) throw new Error("Provider name too long.");
  const parts = [`LogName=${psQuote(logName)}`, `StartTime=(Get-Date).AddMinutes(-${sinceMinutes})`];
  if (provider) parts.push(`ProviderName=${psQuote(provider)}`);
  if (input.event_id !== undefined) {
    if (!Number.isInteger(input.event_id) || input.event_id < 0 || input.event_id > 65535) throw new Error("event_id must be 0-65535.");
    parts.push(`Id=${input.event_id}`);
  }
  const script = [
    `$filter = @{${parts.join(';')}}`,
    `@(Get-WinEvent -FilterHashtable $filter -MaxEvents ${maxEvents} -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,MachineName,Message) | ConvertTo-Json -Compress`
  ].join("; ");
  const events = asArray<Record<string, unknown>>(await runPowerShellJson(context, script, 30_000));
  return { log_name: logName, since_minutes: sinceMinutes, events };
}

export async function hostKillSystemProcess(
  context: HostBreakglassContext,
  input: { pid: number; tree?: boolean; expected_identity_sha256?: string; approval?: string }
) {
  ensureWindows();
  if (!Number.isInteger(input.pid) || input.pid <= 4 || input.pid === process.pid) {
    throw new Error("Refusing to terminate a critical or current process.");
  }

  const target = await processDetails(context, input.pid);
  if (input.expected_identity_sha256) {
    if (!target) throw new Error(`Process not found while checking identity: ${input.pid}`);
    const actualIdentity = processIdentitySha256(target);
    if (actualIdentity.toLowerCase() !== input.expected_identity_sha256.toLowerCase()) {
      throw new Error(`Process identity changed. expected_identity_sha256=${input.expected_identity_sha256} actual_identity_sha256=${actualIdentity}`);
    }
  }
  const name = target?.Name ?? undefined;
  const protectedName = name ? PROTECTED_PROCESS_NAMES.has(name.toLowerCase()) : false;
  if (protectedName && !(context.config.mode === "full" && input.approval === "HOST_BREAKGLASS_FULL")) {
    throw new Error(`Process ${name} is protected in safe mode.`);
  }
  if (target) assertBreakglassProcessNotProtected(target);

  const tree = input.tree === true;
  if (tree) {
    const descendants = await processTreeDetails(context, input.pid);
    const protectedDescendant = descendants.find((entry) => entry.ProcessId !== input.pid && protectedBreakglassRole(entry));
    if (protectedDescendant) {
      throw new Error(
        `Refusing tree termination because descendant PID ${protectedDescendant.ProcessId} is a protected ${protectedBreakglassRole(protectedDescendant)} process.`
      );
    }
  }

  const args = ["/PID", String(input.pid), ...(tree ? ["/T"] : []), "/F"];
  const result = await runBounded(context, "taskkill", args, 30_000);
  return { pid: input.pid, process_name: name, tree, ...result };
}

export async function hostRegistryRead(
  context: HostBreakglassContext,
  input: { key: string; value?: string }
) {
  ensureWindows();
  validateRegistryKey(input.key);
  const args = ["query", input.key, ...(input.value ? ["/v", input.value] : [])];
  return runBounded(context, "reg.exe", args, 30_000);
}

export async function hostRegistryWrite(
  context: HostBreakglassContext,
  input: {
    action: "set" | "delete";
    key: string;
    value: string;
    data?: string;
    type?: "REG_SZ" | "REG_EXPAND_SZ" | "REG_DWORD" | "REG_QWORD" | "REG_MULTI_SZ";
    approval?: string;
  }
) {
  ensureWindows();
  validateRegistryKey(input.key);
  assertRegistryWriteAllowed(context, input.key, input.approval);
  if (!input.value.trim()) throw new Error("Registry value name is required.");

  if (input.action === "delete") {
    return runBounded(context, "reg.exe", ["delete", input.key, "/v", input.value, "/f"], 30_000);
  }
  if (input.data === undefined) throw new Error("Registry data is required for set.");
  const type = input.type ?? "REG_SZ";
  return runBounded(
    context,
    "reg.exe",
    ["add", input.key, "/v", input.value, "/t", type, "/d", input.data, "/f"],
    30_000
  );
}

export async function hostServiceList(context: HostBreakglassContext) {
  ensureWindows();
  return runBounded(context, "sc.exe", ["query", "state=", "all"], 30_000);
}

export async function hostServiceControl(
  context: HostBreakglassContext,
  input: { action: "start" | "stop"; name: string; approval?: string }
) {
  ensureWindows();
  if (!/^[A-Za-z0-9_. -]+$/.test(input.name)) throw new Error("Unsafe service name.");
  const allowed = context.config.services.allowlist.includes(input.name);
  if (!allowed && !(context.config.mode === "full" && input.approval === "HOST_BREAKGLASS_FULL")) {
    throw new Error("Service is not in the configured allowlist.");
  }
  return runBounded(context, "sc.exe", [input.action, input.name], 30_000);
}

async function processDetails(context: HostBreakglassContext, pid: number): Promise<WindowsProcessDetails | undefined> {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -ne $p) { $p | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress }"
  ].join("; ");
  const result = await runBounded(
    context,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    15_000
  );
  if (result.exit_code !== 0 || !result.stdout_tail.trim()) return undefined;
  return parseProcessDetails(result.stdout_tail.trim());
}

async function processTreeDetails(context: HostBreakglassContext, pid: number): Promise<WindowsProcessDetails[]> {
  const script = [
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate)",
    "$ids = [System.Collections.Generic.HashSet[int]]::new()",
    `[void]$ids.Add(${pid})`,
    "do { $added = $false; foreach ($p in $all) { if (-not $ids.Contains([int]$p.ProcessId) -and $ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId); $added = $true } } } while ($added)",
    "@($all | Where-Object { $ids.Contains([int]$_.ProcessId) }) | ConvertTo-Json -Compress"
  ].join("; ");
  const result = await runBounded(
    context,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    30_000
  );
  if (result.exit_code !== 0 || !result.stdout_tail.trim()) return [];
  const parsed = JSON.parse(result.stdout_tail.trim()) as WindowsProcessDetails | WindowsProcessDetails[];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeProcessDetails);
}

function parseProcessDetails(value: string): WindowsProcessDetails {
  return normalizeProcessDetails(JSON.parse(value) as WindowsProcessDetails);
}

function normalizeProcessDetails(value: WindowsProcessDetails): WindowsProcessDetails {
  return {
    ProcessId: Number(value.ProcessId),
    ParentProcessId: Number(value.ParentProcessId),
    Name: value.Name ?? null,
    ExecutablePath: value.ExecutablePath ?? null,
    CommandLine: value.CommandLine ?? null,
    CreationDate: value.CreationDate ?? null
  };
}

function assertBreakglassProcessNotProtected(target: WindowsProcessDetails): void {
  const role = protectedBreakglassRole(target);
  if (role) throw new Error(`Refusing to terminate protected ${role} process PID ${target.ProcessId}.`);
}

export function protectedBreakglassRole(target: WindowsProcessDetails): string | undefined {
  const commandLine = normalizeProcessText(target.CommandLine);
  const executablePath = normalizeProcessText(target.ExecutablePath);

  if (PROTECTED_BREAKGLASS_COMMAND_MARKERS.some((marker) => commandLine.includes(marker))) {
    if (commandLine.includes("host-breakglass-supervisor.mjs")) return "Host Breakglass supervisor";
    if (commandLine.includes("host-breakglass-computer-use.mjs") || commandLine.includes("host-breakglass-gui-child.mjs") || commandLine.includes("computer-use-runtime")) return "Computer-Use";
    if (commandLine.includes("connect-host-breakglass-openai.mjs")) return "Host Breakglass tunnel launcher";
    if (commandLine.includes("dist\\host-breakglass\\server.js")) return "Host Breakglass server";
    return "Host Breakglass component";
  }
  if (PROTECTED_BREAKGLASS_EXECUTABLE_MARKERS.some((marker) => executablePath.includes(marker))) {
    return "OpenAI tunnel-client";
  }
  return undefined;
}

function normalizeProcessText(value: string | null | undefined): string {
  return (value ?? "").replaceAll("/", "\\").toLowerCase();
}

function assertRegistryWriteAllowed(
  context: HostBreakglassContext,
  key: string,
  approval?: string
): void {
  const hive = normalizeHive(key);
  if (context.config.registry.write_hives.includes(hive)) return;
  if (context.config.mode === "full" && approval === "HOST_BREAKGLASS_FULL") return;
  throw new Error(`Registry writes to ${hive} are not enabled.`);
}

function normalizeHive(key: string): "HKCU" | "HKLM" | "HKCR" | "HKU" | "HKCC" {
  const upper = key.toUpperCase();
  const mappings: Array<[string, "HKCU" | "HKLM" | "HKCR" | "HKU" | "HKCC"]> = [
    ["HKEY_CURRENT_USER", "HKCU"],
    ["HKEY_LOCAL_MACHINE", "HKLM"],
    ["HKEY_CLASSES_ROOT", "HKCR"],
    ["HKEY_USERS", "HKU"],
    ["HKEY_CURRENT_CONFIG", "HKCC"]
  ];
  for (const [longName, shortName] of mappings) {
    if (upper === shortName || upper.startsWith(`${shortName}\\`) || upper === longName || upper.startsWith(`${longName}\\`)) {
      return shortName;
    }
  }
  throw new Error("Unsupported registry hive.");
}

function validateRegistryKey(key: string): void {
  if (!key.trim() || key.includes("\n") || key.includes("\r")) throw new Error("Unsafe registry key.");
  normalizeHive(key);
}
function processIdentitySha256(details: WindowsProcessDetails): string {
  return createHash("sha256").update(JSON.stringify({
    pid: details.ProcessId,
    parent_pid: details.ParentProcessId,
    name: details.Name ?? null,
    executable_path: details.ExecutablePath ?? null,
    command_line: details.CommandLine ?? null,
    creation_date: details.CreationDate ?? null
  }), "utf8").digest("hex");
}

async function runPowerShellJson(context: HostBreakglassContext, script: string, timeoutMs: number): Promise<unknown> {
  const result = await runBounded(context, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs);
  if (result.exit_code !== 0) throw new Error(`PowerShell diagnostic failed: ${result.stderr_tail || `exit ${result.exit_code}`}`);
  const text = result.stdout_tail.trim();
  if (!text) return [];
  return JSON.parse(text) as unknown;
}

function asArray<T>(value: unknown): T[] {
  if (value === null || value === undefined || value === "") return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function normalizeTaskName(name: string, path?: string): string {
  const cleanName = name.trim().replace(/^\\+/, "");
  if (!cleanName || cleanName.includes("\n") || cleanName.includes("\r")) throw new Error("Unsafe scheduled task name.");
  const cleanPath = (path ?? "\\").trim().replace(/\//g, "\\");
  const rooted = cleanPath.startsWith("\\") ? cleanPath : `\\${cleanPath}`;
  const normalizedPath = rooted.endsWith("\\") ? rooted : `${rooted}\\`;
  const fullName = `${normalizedPath}${cleanName}`;
  if (fullName.length > 512 || /[\r\n]/.test(fullName)) throw new Error("Unsafe scheduled task path.");
  return fullName;
}
function taskLeaf(fullName: string): string { return fullName.slice(fullName.lastIndexOf("\\") + 1); }
function taskPath(fullName: string): string { const index = fullName.lastIndexOf("\\"); return fullName.slice(0, index + 1) || "\\"; }
function psQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

async function runBounded(
  context: HostBreakglassContext,
  executable: string,
  args: string[],
  timeoutMs: number
) {
  return runProcessWithTail({
    executable,
    args,
    cwd: process.cwd(),
    env: minimalHostEnv(),
    timeout_ms: Math.min(timeoutMs, context.config.limits.max_timeout_ms),
    tail_bytes: context.config.limits.max_output_bytes
  });
}

function ensureWindows(): void {
  if (process.platform !== "win32") throw new Error("This host operation is only supported on Windows.");
}
