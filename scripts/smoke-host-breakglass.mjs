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
    services: { allowlist: [] }
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
  assert(names.length === 21, `expected 21 tools, got ${names.length}: ${names.join(", ")}`);
  for (const required of ["host_read_file", "host_write_file", "host_edit_file", "host_shell", "host_process_start", "host_git", "host_system_info"]) {
    assert(names.includes(required), `missing tool ${required}`);
  }

  const file = join(root, "smoke.txt");
  expectOk(await call("host_write_file", { path: file, content: "alpha", create_directories: true }));
  const readAlpha = expectOk(await call("host_read_file", { path: file }));
  assert(readAlpha.result.content === "alpha", "host_read_file did not return alpha");

  expectOk(await call("host_edit_file", { path: file, old_text: "alpha", new_text: "beta" }));
  const readBeta = expectOk(await call("host_read_file", { path: file }));
  assert(readBeta.result.content === "beta", "host_edit_file did not produce beta");

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
  let job;
  for (let i = 0; i < 40; i += 1) {
    job = expectOk(await call("host_process_output", { job_id: jobId })).result;
    if (job.status !== "running") break;
    await delay(50);
  }
  assert(job?.stdout_tail.includes("JOB_OK"), `managed job missing JOB_OK: ${JSON.stringify(job)}`);

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
    const systemProcesses = expectOk(await call("host_system_processes", {}));
    assert(systemProcesses.result.processes_csv.length > 0, "system process list is empty");
    const services = expectOk(await call("host_service_list", {}));
    assert(services.result.stdout_tail.length > 0, "service list is empty");

    expectOk(await call("host_registry_write", { action: "set", key: "HKCU\\Environment", value: registryValue, data: "SMOKE_OK", type: "REG_SZ" }));
    const registryRead = expectOk(await call("host_registry_read", { key: "HKCU\\Environment", value: registryValue }));
    assert(registryRead.result.stdout_tail.includes("SMOKE_OK"), "registry read did not return test value");
    expectOk(await call("host_registry_write", { action: "delete", key: "HKCU\\Environment", value: registryValue }));

    victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    await delay(100);
    const victimPid = victim.pid;
    expectOk(await call("host_system_process_kill", { pid: victimPid }));
    let victimAlive = true;
    for (let i = 0; i < 40; i += 1) {
      victimAlive = isWindowsProcessAlive(victimPid);
      if (!victimAlive) break;
      await delay(50);
    }
    assert(!victimAlive, "host_system_process_kill did not terminate test process");
    victim = undefined;
  }

  console.log("Host breakglass built MCP smoke PASS (tools/files/shell/process/git-push/windows/registry/services/root-policy/safe-policy).\n");

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
        assert(body?.ok === true && body?.name === "gpt-repo-host-breakglass" && body?.tool_count === 21, `bad health: ${JSON.stringify(body)}`);
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
