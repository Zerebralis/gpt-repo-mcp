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

The host server currently exposes 23 tools:

- roots and filesystem: list roots, stat, read, write, exact edit, directory
  listing, and bounded search;
- execution: bounded shell plus managed process start/output/list/kill;
- Git: status, diff, log, branch, add, commit, fetch, fast-forward pull, push,
  and merge;
- Windows: system information, process listing and guarded process termination,
  registry read/write, and service list/start/stop;
- GUI adapter: an allowed Computer-Use catalog plus a raw MCP call proxy that
  preserves downstream image content.

Git push is disabled unless `git.allow_push` is enabled. Only configured remote
names are accepted. Push and other mutating Git calls can be bound to an
`expected_head` to reject stale state.

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

## MCP Session Resilience

The Streamable HTTP server defaults to 100 concurrent MCP sessions with a 10-minute idle TTL. This is intentionally more tolerant of ChatGPT Secure Tunnel workflows, which may create fresh MCP sessions across separate tool workflows instead of promptly deleting every prior session. Override with `GPT_HOST_BREAKGLASS_MAX_SESSIONS` and `GPT_HOST_BREAKGLASS_SESSION_IDLE_TTL_MS` when needed. `/health` exposes only aggregate session counts and limits for diagnostics; it never returns session IDs.

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
