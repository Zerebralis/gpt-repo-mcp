# Host Breakglass / RDC Fallback

`gpt-repo-host-breakglass` is an opt-in operator recovery server that lives in
this repository but is deliberately separate from the normal `gpt-repo-mcp`
product. Its job is to preserve local recovery capability when the primary host
control plane is unavailable.

The normal repository server keeps its existing focused repository contract and
does not gain arbitrary shell or unrestricted host access.

## Trust Boundary

Host Breakglass is high-authority software. Enable it only on a machine you
control and only with roots and Windows capabilities you intend to expose.

- The server binds to loopback by default.
- The tracked example config starts with `enabled: false`.
- File and Git tools are restricted to configured roots unless deliberate full
  host access is enabled.
- Safe mode blocks selected high-risk commands and protects critical Windows
  processes.
- Registry writes are limited to configured hives in safe mode.
- Service mutation is limited to an allowlist in safe mode.
- Scheduled Task mutation is limited to an explicit allowlist in safe mode.
- Full mode requires `full_host_access: true`; guarded operations additionally
  require the exact `HOST_BREAKGLASS_FULL` approval value.
- Audit records use hashes and bounded metadata rather than command or output
  bodies.

### Important shell limitation

`host_shell` is intentionally a breakglass capability, not a filesystem
sandbox. Its working directory must be inside an approved execute root and safe
mode adds command guardrails, but an arbitrary shell can reference other host
paths. Prefer the bounded file, Git, process, registry, and service tools when
they can perform the task.

Safe Mode also fails closed on shell-level command indirection that cannot be
reliably classified as a direct command: nested PowerShell, `Start-Process`,
`Invoke-Expression`, `Invoke-Command`, alias/function creation, opaque `cmd.exe`
argument layouts, and dynamic invocation operators are rejected. Use
`host_process_start` for an explicit child process instead of escaping through
free-form shell. On Windows, commands that contain scriptblocks, subexpressions,
or native process-creation indirection are additionally parsed with PowerShell's
own AST; every nested `CommandAst` is inspected, while parser errors and dynamic
command names fail closed. Safe Mode also rejects unknown instance/member-method
invocation, object/provider execution indirection, direct script/batch execution,
and native Windows launcher primitives that can execute an opaque child command;
those require Full Mode or a structured Breakglass primitive. Known native launcher primitives are denied in Safe Mode on both the shell and
managed-process surfaces. When an explicit managed process is itself `cmd.exe`
or PowerShell, its structured argument list is inspected; opaque, encoded, or
script-file interpreter entry points require Full Mode rather than being treated
as safely parsed. Arbitrary executable programs remain arbitrary executable code:
Safe Mode does not claim code containment or a sandbox for a deliberately hostile
general-purpose runtime.

## Tool Surface

The host server currently exposes 42 tools:

- roots and filesystem: list roots, stat, read, write, exact edit, directory
  listing, and bounded search;
- connection observability: `host_connection_snapshot` returns stable backend-instance identity,
  aggregate MCP session telemetry, bounded managed-job identities, and optional fail-safe
  incident classification without claiming visibility into ChatGPT session tool registration;
- execution: bounded shell plus managed process start/output/list/kill;
- review interop: `host_review_runtime` exposes only the hash-pinned canonical Review Runtime actions `build_packet`, `review`, and `status`; the deployment receipt itself is SHA-256 pinned in reviewed Breakglass source and every installed runtime file is re-hashed before execution;
- Git: status, diff, log, branch, add, commit, fetch, fast-forward pull, push,
  and merge;
- Windows: system information, process listing and guarded process termination,
  registry read/write, and service list/start/stop;
- GUI adapter: an allowed Computer-Use catalog plus a raw MCP call proxy that
  preserves downstream image content;
- harvested diagnostics: multi-file reads, streaming hashes, process detail/tree
  with identity guards, network listeners/port ownership, Scheduled Tasks,
  Windows Event Log queries, loopback HTTP probes, and batched diagnostics;
- credentialed HTTPS: bounded GET/POST API calls through `host_http_request`, with
  host-side credential references, exact host policy, HTTPS-only transport,
  same-origin redirect enforcement, and bounded/redacted responses;
- safer recovery mutation: line-oriented managed-process stdin plus guarded
  multi-file text change packs with dry-run, stale hashes, and automatic rollback
  on partial apply failure;
- unified GUI observation: one-call window metadata, accessibility tree, and
  optional screenshot through the existing Computer-Use adapter.

`host_edit_file` remains an exact literal replacement primitive rather than a
general patch engine. A successful edit returns the replacement count, pre- and
post-write SHA-256 values, and at most eight matched spans. Before committing, it
atomically claims the exact target path, hashes the bytes that occupied that path
at claim time, and refuses the edit if they differ from the pre-image used to
compute the replacement. The intended post-image is then installed only if no
concurrent writer recreated the path, verified by SHA-256, and finally re-read
through the normal host read path before success is reported. If a concurrent
writer appears during the claim window, that writer is not overwritten; the
pre-edit bytes remain in a bounded recovery backup and the edit fails closed.
Zero matches, non-unique default matches, stale input hashes, and postcondition
mismatches also fail closed. For large/source-critical multiline edits, treat
`postcondition.verified=true` as the write-integrity gate and still run the
relevant syntax/type/test checks for semantic correctness; do not repeat an edit
after an indeterminate/postcondition failure without first reconciling the target
file.

Git push is disabled unless `git.allow_push` is enabled. Only configured remote
names are accepted. Push and other mutating Git calls can be bound to an
`expected_head` to reject stale state.

The harvest roadmap and the provenance of these patterns are recorded in
[HOST_BREAKGLASS_TOOL_HARVEST.md](HOST_BREAKGLASS_TOOL_HARVEST.md). Full PTY
sessions and restart-safe explicit rollback remain follow-up work rather than
being approximated as stronger guarantees than the current implementation.
## Bootstrap Installers

The external runtime dependencies can be restored from a clean Windows host
without rebuilding either project from source:

```powershell
npm run host:computer-use:install
npm run host:tunnel:install
```

Computer-Use is pinned to 7.1.0. The OpenAI tunnel-client installer is pinned
to 0.0.14 and verifies the release archive against a pinned SHA-256 before
extraction.
## Configuration

Copy `config.host-breakglass.example.json` to the ignored
`config.host-breakglass.local.json` and configure only the roots you need.

Local transport configuration belongs in:

```text
%LOCALAPPDATA%\gpt-repo-host-breakglass\host.env
```

Use `host-breakglass.env.example` as the key-name template. Do not commit the
local file. Runtime API keys, tunnel credentials, and path tokens must never be
stored in Git. External API credentials used by `host_http_request` remain local
host inputs; configure only references and host policy. See
[HOST_BREAKGLASS_CREDENTIALED_HTTP.md](HOST_BREAKGLASS_CREDENTIALED_HTTP.md).

## Reliability Runbook

Known transport incidents, diagnostic signatures, durable fixes, and BG-R1d session-local connector-binding recovery are documented in [HOST_BREAKGLASS_RELIABILITY.md](HOST_BREAKGLASS_RELIABILITY.md). Check that runbook first when failures surface as a missing tool namespace, 502, gateway 404, or `tunnel_client_not_seen`.

Durable architectural choices and deliberately rejected/default-excluded approaches are recorded in [HOST_BREAKGLASS_DECISIONS.md](HOST_BREAKGLASS_DECISIONS.md). Use that log when deciding whether a proposed recovery feature belongs in the small independent Breakglass layer at all.

## MCP Session Resilience

The Streamable HTTP server keeps a strict hard cap of 100 concurrent MCP sessions with a 10-minute normal idle TTL. Secure Tunnel churn can create fresh MCP sessions faster than clients delete old ones, so pressure handling uses a separate 60-second pressure idle TTL plus a soft headroom target. `GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET` defaults to 80% of `GPT_HOST_BREAKGLASS_MAX_SESSIONS` (80 with the default cap). When a new admission would exceed that soft target, only pressure-old, idle, non-in-flight sessions are reclaimed toward enough headroom for the admission. A periodic pressure sweep also trims eligible old idle sessions toward the soft target. Fresh sessions and in-flight sessions are never closed merely to satisfy the soft target; if they occupy the full hard cap, admission is rejected instead.


The hard cap, normal idle TTL, pressure idle TTL, and soft target can be configured with `GPT_HOST_BREAKGLASS_MAX_SESSIONS`, `GPT_HOST_BREAKGLASS_SESSION_IDLE_TTL_MS`, `GPT_HOST_BREAKGLASS_SESSION_PRESSURE_IDLE_TTL_MS`, and `GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET`. `/health` exposes the active `mode` and `full_host_access`, a stable process-lifetime `instance_id`/`started_at` pair, aggregate session state, and cumulative counters for committed sessions, normal expirations, pressure reclaims, and rejected admissions. It never returns MCP session IDs. `host_connection_snapshot` reuses that backend identity and additionally exposes bounded managed-job recovery evidence; its `chat_binding.observable=false` marker is deliberate because the server cannot inspect ChatGPT's per-conversation tool registry.



## GUI / Computer-Use Adapter

GUI control is delegated to the pinned local `@zavora-ai/computer-use-mcp`
runtime instead of duplicating screenshot, input, window, and accessibility
implementations inside Host Breakglass.

The local recovery installation uses version `7.1.0` under
`C:\Tools\computer-use-runtime` and starts its HTTP runner on loopback. The
Breakglass adapter itself refuses non-loopback Computer-Use URLs.

The recommended maximum and active profile is `ax`. That provides observation,
pointer/keyboard, window/application, and accessibility/UI Automation while
leaving duplicate filesystem, registry, process, and arbitrary scripting work
to the native Host Breakglass tools.

The downstream `ax` profile currently exposes 46 tools. Host Breakglass allows
44 by default; `read_clipboard` and `write_clipboard` are deliberately excluded
from the default allowlist. Change `computer_use.allowed_tools` only when that
extra authority is actually needed.

Two host tools represent the adapter:

- `host_computer_use_catalog` returns only the downstream tools allowed by the
  Host Breakglass policy;
- `host_computer_use_call` forwards one allowed call and preserves the original
  MCP result, including screenshot image content.

Run the GUI backend alone with:

```powershell
npm run host:computer-use
```

The independent supervisor starts and monitors this backend automatically when
`computer_use.enabled=true`.

Computer Use is optional for native recovery. A missing GUI runtime, startup
failure, readiness timeout, or later GUI crash does not stop or restart the
connector, Host Core, tunnel, or managed jobs. Invalid GUI configuration still
blocks startup. The supervised backend runs directly in its owned child process;
the standalone `host:computer-use` entry uses the same launch configuration.

The supervisor reports `gui.status` (`disabled`, `starting`, `ready`,
`unavailable`, or `degraded`), an ephemeral generation, attempt count, and reason
in its local state. Readiness requires that generation's private IPC report of
its own listening socket and a bounded MCP handshake. An occupied port is never
adopted or cleared. `/health`'s existing `computer_use` field still means
configured/enabled, not live GUI readiness.

GUI recovery allows three total attempts per supervisor lifetime, with 2-second
and 5-second backoffs. Successful starts do not replenish that budget, and
connector restarts do not reset it. Exhaustion remains visibly unavailable or
degraded; there is no endless retry loop. A replacement is allowed only after
the previous owned process has exited. Cleanup uses cooperative IPC and a bounded
fallback on that child handle, never a PID file or a foreign port owner.

The GUI adapter bounds connection establishment to five seconds, discards failed
connections, and lets a later call establish a new one. Existing action timeout
semantics and successful responses remain unchanged. Failed GUI operations are
never replayed automatically, including when their outcome is uncertain.
## Preferred Transport: OpenAI Secure MCP Tunnel

The preferred remote path is OpenAI Secure MCP Tunnel because it is outbound
only and leaves the local MCP server on loopback.

Required local values:

```text
GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN=...
CONTROL_PLANE_TUNNEL_ID=...
CONTROL_PLANE_API_KEY=  # set locally, never commit
```

The connector passes secrets by environment, not as command-line arguments.
The local MCP binding is `127.0.0.1` and does not need a public path token when
using the OpenAI tunnel.

Commands:

```powershell
npm run host:doctor
npm run host:connect
```

`host:doctor` reports core health and transport readiness separately. Use
`node scripts/host-breakglass-doctor.mjs --core-only` when validating the host
core before tunnel credentials exist.

## Secondary Transports

Two secondary launchers are retained for diagnostics and contingency use:

```powershell
npm run host:connect:cloudflare
npm run host:connect:ngrok
```

They are not the preferred production path. Quick Cloudflare tunnel URLs are
ephemeral and Cloudflare Tunnel requires its own outbound network path. ngrok
accounts may also map a default endpoint to only one active local service. Do
not use endpoint pooling to mix the normal repo server and Host Breakglass.

## Independent Lifecycle

The Breakglass stack must not depend on AWA, RDC, or the normal Repo MCP
process. The supervisor runs the OpenAI connector independently and restarts it
with bounded backoff:

GUI lifecycle is separate from ordinary connector failure recovery. The OpenAI
connector starts Core once and replaces only its own tunnel generation on tunnel
failure. Core functional liveness is checked separately as described below.
Recovery after supervisor failure and job persistence remain out of scope. A Core
restart still loses in-memory job handles; GUI and tunnel recovery do not.

The supervisor now reconciles deliberate local configuration changes automatically.
It fingerprints the effective `host.env` plus the selected Host Breakglass config
while the stack is running. A changed candidate must settle to the same fingerprint
and then pass the built Core's own `--validate-config` path before teardown; invalid,
temporarily incomplete, or schema-invalid candidates leave the current runtime
serving and are surfaced as `config_reload.status=blocked` in supervisor state. A
valid change causes a controlled connector/Core/tunnel and GUI recycle with no
failure backoff.
The replacement connector accepts Core readiness only when `/health` reports the
expected `mode` and `full_host_access`. The supervisor never chooses or rewrites
those policy values itself; it only converges the running stack to the operator-
supplied configuration.

```powershell
npm run host:supervisor
```

Windows login autostart uses a dedicated Task Scheduler entry:

```powershell
npm run host:autostart:status
npm run host:autostart:install
npm run host:autostart:uninstall
```

Installation fails closed when the tunnel ID, runtime API key, or tunnel-client
binary is missing. The task runs at ordinary user privilege and starts only
after that user logs in.

Runtime state and logs live under `%LOCALAPPDATA%\gpt-repo-host-breakglass` and
are not part of the repository.

### Connector-local tunnel generations (Windows)

The connector retries transient tunnel failures after confirmed cleanup with
2-second and 5-second initial backoff. After the third failure it remains visibly
`degraded` with `recovery: slow` and `retry_in_ms`, continuing after 15, 30 and then
60 seconds. Further delays stay capped at 60 seconds. `attempts` is cumulative;
`failure_streak` controls the current recovery delay. Short readiness does not
reset it. Five continuous minutes of ready reset only `failure_streak`, so a later
independent failure starts again at 2 seconds while cumulative attempts remain.
The reset timer belongs to its generation and is canceled on failure or shutdown;
even a failed watchdog probe below the recycle threshold interrupts the stable
window. A stale callback cannot reset a newer generation or readiness window.
Missing binaries, failed startup, readiness or poll
timeouts, later root exit and the existing three-failure watchdog affect only the
tunnel. There is no terminal retry budget for these recoverable failures. Core,
local MCP sessions, managed job IDs/handles/output and the independently
supervised GUI remain available throughout slow recovery.
Core exit, explicit overall shutdown and invalid security configuration remain
fatal. The supervisor's existing connector policy is otherwise unchanged.

Each generation has a UUID, an abort fence, its own startup deadline and watchdog,
and private discovery/log paths under `tunnel-generations/<UUID>`. Readiness needs
both `/readyz` and a fresh successful poll from this process lifetime. The
10-second watchdog, three consecutive failures and configured poll stale limit
are preserved. Stale asynchronous work cannot publish or stop a newer generation.

Windows PowerShell loads the small native ownership helper. It creates a private,
unnamed Job Object with kill-on-close, creates the tunnel suspended, assigns it
to that job, then resumes it. Only the three standard I/O handles are inherited;
the job handle is private. The real tunnel's `cmd -> node -> codex` sidecars inherit
job membership. Core and GUI are spawned outside this job. PID files, names,
ports and old state never authorize adoption or termination. The health listener
must match the root process in the owned job before startup probes proceed.

Cleanup requests the owner helper to terminate its job and confirm an empty job
and signaled root handle before the helper exits. This is forced backend cleanup,
not a claim that Windows SIGTERM recursively or gracefully closes sidecars.
Unconfirmed ownership/cleanup blocks replacement (`reason: cleanup_unconfirmed`).
These fail-closed cases remain terminal regardless of elapsed time; slow recovery
never overrides an unconfirmed old generation or permits overlapping generations.
Helper loss closes the job as a safety fallback, but is not treated as confirmed
cleanup. Shutdown cancels starts/probes/retries before waiting for tunnel cleanup
and then follows the existing overall Core shutdown path.

`connector-state.json` retains successful fields and adds generation, attempt,
PID/creation identity and lifecycle status. The old health/PID filenames are only
serialized compatibility views of the current ready generation. Doctor requires
matching state/discovery, live Windows FILETIME identity, readiness and fresh
polling; missing or stale discovery fails closed. Discovery never grants ownership.
Generation logs are private runtime data and may contain sensitive backend output;
do not publish them. Automatic retention/rotation is not part of this slice.

Reconnect starts a transport connection only. It does not replay MCP operations.
Remote sessions may be lost; a lost response can still mean outcome unknown.
Clients must not retry mutations merely because the tunnel was replaced.

The opt-in compatibility smoke uses the installed v0.0.14 binary with a private
CODEX_HOME, private state and a local control-plane stub:

```powershell
node tests/host-breakglass-tunnel-ownership-smoke.mjs
```

It checks real sidecar job membership, listener ownership, root-only failure,
confirmed cleanup and a new ready generation. It does **not** establish real
OpenAI control-plane or ChatGPT connector acceptance; that remains a separately
authorized live gate. Production configuration and processes must remain untouched
when running this smoke.

## Validation

### Operation results and audit failures

Audit recording is attempted once after an operation has produced its result.
An audit-write failure does not change the operation's result, `isError`, or
existing error code/message, and never causes the operation to run again.
This also applies to the Computer-Use proxy and window-observation wrapper;
existing content blocks, including images, remain intact.

When audit recording fails, one additional MCP text content block contains:

```json
{"audit":{"ok":false,"code":"HOST_BREAKGLASS_AUDIT_WRITE_FAILED","message":"Audit recording failed. The operation result is unchanged; do not repeat the operation solely because of this audit failure."}}
```

The warning describes audit recording only. It is not an operation failure or
permission to retry a mutation. Raw audit-sink error details are not returned.
When audit recording succeeds (or audit is not configured), the response shape
is unchanged. This contract does not add audit persistence guarantees or
operation deduplication across separate requests.

The built smoke exercises the server through MCP, not direct function calls:

```powershell
npm run host:smoke
```

It covers file read/write/edit, root rejection, safe shell blocking, managed
processes, Git commit and push to a temporary bare remote, stale-HEAD rejection,
Windows process discovery/termination, HKCU registry set/read/delete, service
listing, and system information. Test fixtures are temporary and cleaned up.

Before committing changes to this subsystem also run:

```powershell
npm run typecheck
npm run lint
npm run check:public
npm run build
```

## Self-contained release packaging

`npm run host:release -- --out <release-directory>` builds a versioned release
from a **clean checkout** using the existing `npm run build` first. Install the
locked build dependencies with `npm ci` before building. The builder requires
MCP SDK **1.29.0** and the direct, exact development dependency **esbuild 0.27.7**.

Only the release outputs of the GUI runtime, Core functional watchdog and existing Core build are
bundled as Node/ESM, including their npm dependencies. Node builtins remain
external. Bundling does not change source behavior, retry policies, tool contracts
or GUI lifecycle. The GUI child remains a separate neighboring
file; all other allowlisted runtime scripts are copied byte-for-byte.

The release contains no `node_modules` directory and needs no `NODE_PATH` or
repository installation at runtime. Node.js (the manifest's Node requirement),
Windows PowerShell, the Computer-Use runtime and the Secure MCP Tunnel runtime
with its existing host prerequisites must still be provisioned separately.
Configuration, credentials, state and audit targets are external deployment
inputs and are never copied into the release.

Each version directory contains `runtime/`, a deterministic `.tar.gz` archive
and its SHA-256 sidecar. Archive members are sorted, with fixed timestamps,
permissions and owner metadata. `release-manifest.json` binds the Git commit
and tree, clean state, Node requirement, lockfile hash, SDK/bundler versions,
builder version/hash, GUI and Core-watchdog source and bundle hashes, Core build and bundle
hashes, all bundler input hashes, and every payload file's relative path/hash.
It contains no absolute host paths, credentials, runtime PIDs or ports.
An existing version is never overwritten.

For uncommitted review only, `npm run host:release -- --preview` permits a dirty
checkout and emits an explicitly named **review-preview**. Its Git identity is
the base commit/tree; it is not a claim that the preview is committed. Source,
bundle and payload hashes bind the preview bytes. A regular release must be
rebuilt from the reviewed, committed, clean checkout before deployment.

Packaging regression: `npx vitest run tests/host-breakglass-release.test.mjs`.
This builds twice in different directories, compares bytes, extracts the
archive with `tar`, checks unchanged scripts and manifest coverage, and runs
GUI imports and Core health outside the repository. ESM and CommonJS guards
actively reject module resolution outside the release, with a negative control
for the repository SDK. No ancestor `node_modules` or `NODE_PATH` is available.

Explicit Windows real-runtime gate:
`npm run host:release:smoke -- <release-runtime-directory>`. It copies the
release to a new OS temporary directory outside the repository, uses isolated
state/configuration/audit and free alternative loopback ports, starts the real
Computer-Use backend, probes its MCP handshake and read-only display-size call,
and verifies native Core health and 41 MCP tools. The real tunnel runs against
an isolated local control-plane stub via the connector's existing test seam;
production credentials and the real remote control plane are not used. The
actual supervisor entry is separately imported/started against an isolated
missing-credential gate. Cleanup verifies owned processes, free ports and
unchanged foreign tunnel/Codex identities. The private report remains in the
temporary test directory for review. No Scheduled Task is changed by the
builder or smoke; production activation requires separate authorization.

## Core functional liveness (implementation candidate; not live accepted)

The connector continues to spawn and own the Core child. `/health` remains the
startup gate, but a successful health response alone does not prove that MCP
request dispatch still works. After startup, a connector-local watchdog opens
its own loopback MCP session and calls only `host_system_info` with empty
arguments. The successful operation envelope must contain the exact PID of
the child spawned by this connector. A separate audit warning does not invalidate
a successful operation; a tool error, missing/ambiguous result, wrong PID,
transport error or deadline expiry is a functional failure.

The first probe starts immediately after the startup gate and tunnel lifecycle
initialization. Subsequent probes run 30 seconds after the preceding probe
settles, with at most one in flight. A 5-second total budget includes session
initialization, the initialized notification, and the tool response. Successful
probes reset the consecutive failure counter; one or two failures cause no
restart. Three consecutive failures trigger the connector's existing shutdown
exactly once. The existing supervisor then applies its connector restart/backoff.
There is no additional supervisor or independent Core restart mechanism.

Healthy probes reuse one private MCP session. A failed connection is discarded,
its I/O is aborted and its session receives a best-effort DELETE with a 500 ms
budget. The next scheduled probe may create a new session; there is no immediate
probe retry or MCP request replay. Session IDs are not published. The watchdog's
SDK dependency is bundled into the release, preserving out-of-repository startup
without `node_modules` or `NODE_PATH`.

The private watchdog intentionally does not open the optional standalone MCP
GET/SSE notification stream. Its fetch wrapper answers GET requests to exactly
its own loopback MCP URL locally with HTTP 405, which the SDK treats as an
unsupported optional channel. This avoids idle background SSE body timeouts
being mistaken for functional probe failures. Initialize, notifications and
tool-call POSTs (including SSE responses to POST), session DELETE and other
methods still use the real transport. Client errors and closes still invalidate
the connection; probe deadlines, failure thresholds and recovery are unchanged.

Each watchdog instance is bound to one Core spawn generation and each in-flight
probe has its own identity/cancellation scope. Shutdown fences callbacks, cancels
the next probe and aborts outstanding I/O before the existing tunnel/Core cleanup.
Late results cannot update failure counts, close a newer session or trigger
recovery after shutdown. Logs report only degraded/failed status and consecutive
failure count, without connection details or raw tool output.

GUI and tunnel recovery policies are unchanged. A confirmed Core failure invokes
the existing overall connector shutdown, so its tunnel also stops and in-memory
Managed Job mappings are lost. This watchdog does not add job persistence, child
process adoption, mutation replay or stronger Windows descendant cleanup. The
independently owned GUI remains under its existing supervisor lifecycle.

Focused tests: `npx vitest run tests/host-breakglass-core-liveness.test.mjs
tests/host-breakglass-core-liveness-integration.test.mjs`. Packaging tests also
execute the bundled watchdog against a real Core outside the repository, with
ESM/CommonJS dependency guards and checks for session reuse and termination.
Production activation and live acceptance require separate authorization.

## Acceptance Target

Host-Core acceptance is not the final RDC-retirement acceptance. The complete
fallback is accepted only when a fresh chat can use the independent connector
with RDC and AWA unavailable to:

1. inspect an AWA failure;
2. read and edit the required local files;
3. run PowerShell/Node diagnostics and control relevant processes;
4. restore/start AWA;
5. review Git state, commit, and push a bounded repair branch; and
6. verify AWA is reachable again.

The Computer-Use adapter now covers screenshots, mouse/keyboard, windows,
applications, and Windows UI Automation through the independent loopback
runtime. Browser automation therefore works at the desktop/UI level;
browser-session-specific AWA semantics remain a separate capability and are not
implied by this adapter.
