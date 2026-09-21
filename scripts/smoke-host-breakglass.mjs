/* global process, console, setTimeout, URL, fetch, AbortSignal */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(join(tmpdir(), "gpt-host-breakglass-smoke-"));
const outside = await mkdtemp(join(tmpdir(), "gpt-host-breakglass-outside-"));
const bareRemote = join(outside, "remote.git");
const registryValue = `GPT_HOST_BREAKGLASS_SMOKE_${process.pid}`;
const configPath = join(root, "host.json");
const auditPath = join(root, "audit.jsonl");
const port = await freePort();
let child;
let client;
let victim;

try {
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    mode: "safe",
    full_host_access: false,
    roots: [{ id: "smoke", root, read: true, write: true, execute: true }],
    audit_path: auditPath,
    git: { allow_push: true, allow_merge: true, allowed_remotes: ["origin"] },
    registry: { write_hives: ["HKCU"] },
    services: { allowlist: [] },
    scheduled_tasks: { allowlist: [] }
  }), "utf8");

  initGit(root);
  initBareGit(bareRemote);
  runGitFixture(root, ["remote", "add", "origin", bareRemote]);
  child = spawn(process.execPath, ["dist/host-breakglass/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GPT_HOST_BREAKGLASS_CONFIG: configPath,
      GPT_HOST_BREAKGLASS_HOST: "127.0.0.1",
      GPT_HOST_BREAKGLASS_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = bounded(output + chunk.toString()); });
  child.stderr.on("data", (chunk) => { output = bounded(output + chunk.toString()); });
  await waitForHealth(child, port, () => output);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  client = new Client({ name: "host-breakglass-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert(names.length === 40, `expected 40 tools, got ${names.length}: ${names.join(", ")}`);
  for (const required of ["host_read_file", "host_read_many", "host_file_hash", "host_write_file", "host_edit_file", "host_apply_changes", "host_shell", "host_process_start", "host_process_input", "host_git", "host_system_info", "host_system_process_detail", "host_network_listeners", "host_port_owner", "host_task_list", "host_eventlog_query", "host_http_probe", "host_http_request", "host_diagnostics_batch", "host_window_observe", "host_computer_use_catalog", "host_computer_use_call"]) {
    assert(names.includes(required), `missing tool ${required}`);
  }

  const file = join(root, "smoke.txt");
  expectOk(await call("host_write_file", { path: file, content: "alpha", create_directories: true }));
  const readAlpha = expectOk(await call("host_read_file", { path: file }));
  assert(readAlpha.result.content === "alpha", "host_read_file did not return alpha");

  const edit = expectOk(await call("host_edit_file", { path: file, old_text: "alpha", new_text: "beta" }));
  assert(edit.result.replacement_count === 1 && edit.result.postcondition?.verified === true && edit.result.postcondition?.method === "cas-claim+full-reread-sha256" && /^[a-f0-9]{64}$/i.test(edit.result.pre_sha256) && /^[a-f0-9]{64}$/i.test(edit.result.post_sha256), "host_edit_file missing verified postcondition evidence");
  const readBeta = expectOk(await call("host_read_file", { path: file }));
  assert(readBeta.result.content === "beta", "host_edit_file did not produce beta");

  const many = expectOk(await call("host_read_many", { files: [{ path: file }, { path: configPath }], max_total_bytes: 32_768 }));
  assert(many.result.returned_files === 2, "host_read_many did not return both files");
  const hashed = expectOk(await call("host_file_hash", { path: file }));
  assert(/^[a-f0-9]{64}$/i.test(hashed.result.hash), "host_file_hash did not return SHA-256");
  const packFile = join(root, "pack.txt");
  const packPreview = expectOk(await call("host_apply_changes", { dry_run: true, changes: [{ type: "write", path: packFile, content: "PACK_OK", expected_missing: true }] }));
  assert(packPreview.result.dry_run === true, "host_apply_changes dry-run not reported");
  expectOk(await call("host_apply_changes", { changes: [{ type: "write", path: packFile, content: "PACK_OK", expected_missing: true }] }));
  assert(expectOk(await call("host_read_file", { path: packFile })).result.content === "PACK_OK", "host_apply_changes did not apply pack");
  const healthProbe = expectOk(await call("host_http_probe", { url: `http://127.0.0.1:${port}/health`, max_body_bytes: 4096 }));
  assert(healthProbe.result.status === 200, "host_http_probe did not reach isolated health endpoint");
  const batch = expectOk(await call("host_diagnostics_batch", { operations: [
    { tool: "system_info", args: {} },
    { tool: "stat", args: { path: file } },
    { tool: "file_hash", args: { path: file } },
    { tool: "http_probe", args: { url: `http://127.0.0.1:${port}/health`, method: "HEAD" } }
  ] }));
  assert(batch.result.failed === 0 && batch.result.succeeded === 4, `host_diagnostics_batch failure: ${JSON.stringify(batch.result)}`);

  const shell = expectOk(await call("host_shell", {
    cwd: root,
    command: `node -e "process.stdout.write('SHELL_OK')"`,
    timeout_ms: 10_000
  }));
  assert(shell.result.stdout_tail.includes("SHELL_OK"), "host_shell output missing SHELL_OK");

  const guardedCommand = ["power", "shell -Enc", "odedCommand AAAA"].join("");
  const guarded = await call("host_shell", { cwd: root, command: guardedCommand, timeout_ms: 2_000 });
  assert(guarded.isError === true, "safe policy did not reject guarded command");

  const started = expectOk(await call("host_process_start", {
    executable: process.execPath,
    args: ["-e", "setTimeout(() => { process.stdout.write('JOB_OK'); }, 100)"],
    cwd: root,
    timeout_ms: 5_000
  }));
  const jobId = started.result.job_id;
  const reconciledStarted = expectOk(await call("host_process_list", { job_id: jobId })).result;
  assert(reconciledStarted.found === true && reconciledStarted.job?.job_id === jobId, "host_process_list did not reconcile the exact managed job");
  const unknownManaged = expectOk(await call("host_process_list", { job_id: "00000000-0000-4000-8000-000000000001" })).result;
  assert(unknownManaged.found === false && unknownManaged.manager_state === "unknown", "host_process_list did not keep unknown job identity separate");
  let job;
  for (let i = 0; i < 40; i += 1) {
    job = expectOk(await call("host_process_output", { job_id: jobId })).result;
    if (job.status !== "running") break;
    await delay(50);
  }
  assert(job?.stdout_tail.includes("JOB_OK"), `managed job missing JOB_OK: ${JSON.stringify(job)}`);

  const interactive = expectOk(await call("host_process_start", {
    executable: process.execPath,
    args: ["-e", "process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { process.stdout.write('INPUT_OK:'+d.trim()); process.exit(0); });"],
    cwd: root,
    timeout_ms: 5_000
  }));
  expectOk(await call("host_process_input", { job_id: interactive.result.job_id, chars: "hello\n", end: true }));
  let interactiveJob;
  for (let i = 0; i < 40; i += 1) {
    interactiveJob = expectOk(await call("host_process_output", { job_id: interactive.result.job_id })).result;
    if (interactiveJob.status !== "running") break;
    await delay(50);
  }
  assert(interactiveJob?.stdout_tail.includes("INPUT_OK:hello"), `managed process input failed: ${JSON.stringify(interactiveJob)}`);

  const tracked = join(root, "tracked.txt");
  expectOk(await call("host_write_file", { path: tracked, content: "tracked-v1\n" }));
  expectOk(await call("host_git", { cwd: root, operation: "add", paths: ["tracked.txt"] }));
  const committed = expectOk(await call("host_git", { cwd: root, operation: "commit", message: "smoke commit" }));
  assert(/^[a-f0-9]{40}$/i.test(committed.result.head), "host_git commit did not return a commit HEAD");
  const log = expectOk(await call("host_git", { cwd: root, operation: "log" }));
  assert(log.result.stdout.includes("smoke commit"), "host_git log missing smoke commit");
  const branch = expectOk(await call("host_git", { cwd: root, operation: "branch" })).result.stdout.trim();
  assert(branch.length > 0, "host_git branch did not return a branch");
  expectOk(await call("host_git", { cwd: root, operation: "push", remote: "origin", branch, expected_head: committed.result.head }));
  const remoteHead = runGitFixture(root, ["--git-dir", bareRemote, "rev-parse", `refs/heads/${branch}`]).stdout.trim();
  assert(remoteHead === committed.result.head, "host_git push did not publish committed HEAD");
  const staleHead = await call("host_git", { cwd: root, operation: "status", expected_head: "0".repeat(40) });
  assert(staleHead.isError === true, "host_git expected_head guard did not reject stale state");

  const outsideRead = await call("host_read_file", { path: join(outside, "blocked.txt") });
  assert(outsideRead.isError === true, "outside-root path was not rejected");

  const systemInfo = expectOk(await call("host_system_info", {}));
  assert(typeof systemInfo.result.node === "string", "system info missing node runtime");

  if (process.platform === "win32") {
    const selfDetail = expectOk(await call("host_system_process_detail", { pid: process.pid }));
    assert(/^[a-f0-9]{64}$/i.test(selfDetail.result.IdentitySha256), "process detail missing identity hash");
    const systemProcesses = expectOk(await call("host_system_processes", {}));
    assert(systemProcesses.result.processes_csv.length > 0, "system process list is empty");
    const listeners = expectOk(await call("host_network_listeners", {}));
    assert(Array.isArray(listeners.result.listeners), "network listeners did not return an array");
    const owner = expectOk(await call("host_port_owner", { port }));
    assert(owner.result.listeners.length >= 1, "port owner did not find isolated Breakglass server");
    const tasks = expectOk(await call("host_task_list", { name_contains: "GPT Host Breakglass", limit: 20 }));
    assert(Array.isArray(tasks.result.tasks), "scheduled task list did not return an array");
    const events = expectOk(await call("host_eventlog_query", { log_name: "System", since_minutes: 60, max_events: 3 }));
    assert(Array.isArray(events.result.events), "event log query did not return an array");
    const services = expectOk(await call("host_service_list", {}));
    assert(services.result.stdout_tail.length > 0, "service list is empty");

    expectOk(await call("host_registry_write", { action: "set", key: "HKCU\\Environment", value: registryValue, data: "SMOKE_OK", type: "REG_SZ" }));
    const registryRead = expectOk(await call("host_registry_read", { key: "HKCU\\Environment", value: registryValue }));
    assert(registryRead.result.stdout_tail.includes("SMOKE_OK"), "registry read did not return test value");
    expectOk(await call("host_registry_write", { action: "delete", key: "HKCU\\Environment", value: registryValue }));

    victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    await delay(100);
    const victimPid = victim.pid;
    const victimIdentity = expectOk(await call("host_system_process_detail", { pid: victimPid })).result.IdentitySha256;
    expectOk(await call("host_system_process_kill", { pid: victimPid, expected_identity_sha256: victimIdentity }));
    let victimAlive = true;
    for (let i = 0; i < 40; i += 1) {
      victimAlive = isWindowsProcessAlive(victimPid);
      if (!victimAlive) break;
      await delay(50);
    }
    assert(!victimAlive, "host_system_process_kill did not terminate test process");
    victim = undefined;
  }

  console.log("Host breakglass built MCP smoke PASS (40 tools/files/change-pack/process-input/git/windows/network/tasks/eventlog/http/registry/services/root-policy/safe-policy).\n");

  async function call(name, args) {
    return client.callTool({ name, arguments: args });
  }
} finally {
  if (victim && victim.exitCode === null && victim.signalCode === null) victim.kill("SIGKILL");
  if (process.platform === "win32") spawnSync("reg.exe", ["delete", "HKCU\\Environment", "/v", registryValue, "/f"], { stdio: "ignore", windowsHide: true });
  if (client) await client.close().catch(() => undefined);
  await stopChild(child);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

function expectOk(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  const parsed = text ? JSON.parse(text) : undefined;
  if (result.isError || !parsed?.ok) throw new Error(`Tool failed: ${text ?? JSON.stringify(result)}`);
  return parsed;
}
function isWindowsProcessAlive(pid) {
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 && result.stdout.includes(`"${pid}"`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function bounded(value) { return value.length > 12_000 ? value.slice(-12_000) : value; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function initGit(cwd) {
  for (const args of [["init"], ["config", "user.name", "Breakglass Smoke"], ["config", "user.email", "smoke@example.invalid"]]) runGitFixture(cwd, args);
}
function initBareGit(cwd) { runGitFixture(process.cwd(), ["init", "--bare", cwd]); }
function runGitFixture(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function waitForHealth(processHandle, portNumber, readOutput) {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error(`server exited early\n${readOutput()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) {
        const body = await response.json();
        assert(body?.ok === true && body?.name === "gpt-repo-host-breakglass" && body?.tool_count === 40, `bad health: ${JSON.stringify(body)}`);
        return;
      }
    } catch {
      // Server may still be starting.
    }
    await delay(75);
  }
  throw new Error(`server did not become healthy\n${readOutput()}`);
}
async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  processHandle.kill("SIGTERM");
  const stopped = await Promise.race([once(processHandle, "exit").then(() => true), delay(1500).then(() => false)]);
  if (!stopped && processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill("SIGKILL");
    await once(processHandle, "exit");
  }
}
