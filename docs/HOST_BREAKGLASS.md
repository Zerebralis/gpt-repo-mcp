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

## Tool Surface

The host server currently exposes 39 tools:

- roots and filesystem: list roots, stat, read, write, exact edit, directory
  listing, and bounded search;
- execution: bounded shell plus managed process start/output/list/kill;
- Git: status, diff, log, branch, add, commit, fetch, fast-forward pull, push,
  and merge;
- Windows: system information, process listing and guarded process termination,
  registry read/write, and service list/start/stop;
- GUI adapter: an allowed Computer-Use catalog plus a raw MCP call proxy that
  preserves downstream image content;
- harvested diagnostics: multi-file reads, streaming hashes, process detail/tree
  with identity guards, network listeners/port ownership, Scheduled Tasks,
  Windows Event Log queries, loopback HTTP probes, and batched diagnostics;
- safer recovery mutation: line-oriented managed-process stdin plus guarded
  multi-file text change packs with dry-run, stale hashes, and automatic rollback
  on partial apply failure;
- unified GUI observation: one-call window metadata, accessibility tree, and
  optional screenshot through the existing Computer-Use adapter.

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
stored in Git.

## Reliability Runbook

Known transport incidents, diagnostic signatures, and durable fixes are documented in [HOST_BREAKGLASS_RELIABILITY.md](HOST_BREAKGLASS_RELIABILITY.md). Check that runbook first when failures surface as 502, gateway 404, or `tunnel_client_not_seen`.

Durable architectural choices and deliberately rejected/default-excluded approaches are recorded in [HOST_BREAKGLASS_DECISIONS.md](HOST_BREAKGLASS_DECISIONS.md). Use that log when deciding whether a proposed recovery feature belongs in the small independent Breakglass layer at all.

## MCP Session Resilience

The Streamable HTTP server keeps a strict hard cap of 100 concurrent MCP sessions with a 10-minute normal idle TTL. Secure Tunnel churn can create fresh MCP sessions faster than clients delete old ones, so pressure handling uses a separate 60-second pressure idle TTL plus a soft headroom target. `GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET` defaults to 80% of `GPT_HOST_BREAKGLASS_MAX_SESSIONS` (80 with the default cap). When a new admission would exceed that soft target, only pressure-old, idle, non-in-flight sessions are reclaimed toward enough headroom for the admission. A periodic pressure sweep also trims eligible old idle sessions toward the soft target. Fresh sessions and in-flight sessions are never closed merely to satisfy the soft target; if they occupy the full hard cap, admission is rejected instead.

The hard cap, normal idle TTL, pressure idle TTL, and soft target can be configured with `GPT_HOST_BREAKGLASS_MAX_SESSIONS`, `GPT_HOST_BREAKGLASS_SESSION_IDLE_TTL_MS`, `GPT_HOST_BREAKGLASS_SESSION_PRESSURE_IDLE_TTL_MS`, and `GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET`. `/health` exposes aggregate session state plus cumulative process-lifetime counters for committed sessions, normal expirations, pressure reclaims, and rejected admissions. It never returns session IDs.

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

GUI lifecycle is separate from that connector cycle. Tunnel-to-Core coupling,
Core liveness supervision, recovery after supervisor failure, and job persistence
remain outside this isolation change. A Core restart still loses in-memory job
handles; a GUI restart does not. Configuration changes require an explicit
controlled restart; GUI configuration is not hot-reloaded across connector retries.

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
