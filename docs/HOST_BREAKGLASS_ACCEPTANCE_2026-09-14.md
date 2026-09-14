# Host Breakglass Acceptance � 2026-09-14

## Status

| Layer | Status | Evidence |
| --- | --- | --- |
| Separate Host MCP server | ACCEPTED locally | Normal Repo MCP remains separate; Host Breakglass exposes its own 23-tool surface. |
| Files / shell / processes / Git / Windows | ACCEPTED locally | Built MCP smoke passed file mutation, bounded shell, managed processes, Git commit + push to a temporary bare remote, stale-HEAD rejection, Windows processes, HKCU registry set/read/delete, services, and root policy. |
| GUI / Computer-Use | ACCEPTED locally | Pinned Computer-Use 7.1.0 `ax` runtime; GUI smoke passed catalog filtering, screenshot image passthrough, and mouse movement. |
| Independent lifecycle | IMPLEMENTED | Breakglass supervisor owns Computer-Use + Secure MCP Tunnel children with bounded restart backoff; Windows logon task installer is fail-closed. |
| OpenAI Secure MCP transport | ACCEPTED remote | Official Windows tunnel-client 0.0.14 is authenticated, the supervisor/autostart stack is running, `/readyz` and `/healthz` return 200, and a fresh ChatGPT conversation successfully called Host Breakglass. |
| AWA recovery rehearsal | ACCEPTED for diagnosis | AWA was discovered and inspected through Host Breakglass, its test/check chain was executed through Host Breakglass, and its host-runtime doctor was read through Host Breakglass. |
| Final RDC-off + AWA-off remote recovery | PREFLIGHT IN PROGRESS | Fresh-chat system/root/shell calls passed. RDC and AWA process chains were identified read-only. A session-capacity incident was found and hardened before any intentional control-plane shutdown. |

## Local Release Gates

The Host-Core gate passed:

- lint: PASS
- TypeScript typecheck: PASS
- targeted Host policy + normal network-boundary tests: PASS
- Host MCP smoke: PASS
- public hygiene: PASS
- production dependency audit: 0 vulnerabilities
- `git diff --check`: PASS

The GUI gate additionally passed:

- Computer-Use policy rejects non-loopback adapter URLs;
- Computer-Use runtime starts from the pinned local package without `npx` or a runtime network dependency;
- `host_computer_use_catalog` exposes 44 allowed `ax` tools;
- clipboard read/write is excluded by default;
- screenshot content survives the proxy as MCP `image` content;
- a mouse action succeeds through Host Breakglass -> Computer-Use;
- GUI smoke is reproducible with `npm run host:gui:smoke`.

## AWA Recovery Rehearsal

The rehearsal deliberately used Host Breakglass MCP calls for the AWA-facing work rather than using RDC as the execution bus.

Observed through Breakglass:

- the AWA repository is reachable in an approved project root;
- `package.json` identifies the project as `astra-webchat-autonomy`;
- Git status can be inspected;
- Node can be executed from the AWA working directory;
- Windows process state can be inspected;
- the GUI adapter is reachable;
- `npm run check` completed with exit code 0 and **165/165 tests passing**.

AWA's own host-runtime doctor then reported:

```text
health: blocked
nextAction: manual-inspection
runtime: HEALTHY
autostart: conflict
browser: healthy-managed
telegram: active
browserControl: none
```

The autostart reconciliation status classified the current launcher as
`recognized-other-checkout`. No automatic AWA recovery mutation was performed,
because the runtime itself was healthy and the authoritative doctor explicitly
requested manual inspection. This is the correct fail-closed behavior.

## Remote Connector Verification

A fresh ChatGPT conversation selected the `Host Breakglass` Tunnel connector and verified the independent path end to end:

- `host_system_info` returned Windows 10.0.19045, x64, and Node.js v24.14.0;
- `host_list_roots` returned the six configured root names;
- `host_shell` executed `Write-Output "HOST_BREAKGLASS_EXEC_OK"` with exit code 0 and empty stderr;
- the subsequent read-only failover preflight identified both the RDC stack and the active AWA runtime stack without mutating either.

During the longer preflight, the original 25-session / 30-minute transport defaults proved too small for ChatGPT Secure Tunnel workflows that create fresh MCP sessions across separate tool workflows. The Breakglass defaults are now 100 sessions with a 10-minute idle TTL, `/health` reports aggregate session usage, and capacity exhaustion emits a local diagnostic without exposing session IDs. A deliberate 40-session leak simulation passed 40/40 initializations, reported 40/100 active sessions, then returned to 0/100 after a clean supervisor restart while the OpenAI tunnel remained `ready`.
## Bootstrap Artifacts

Two external runtime dependencies are now reproducible:

```powershell
npm run host:computer-use:install
npm run host:tunnel:install
```

- Computer-Use is pinned to `7.1.0` and verified after installation.
- OpenAI tunnel-client is pinned to `0.0.14`; the Windows archive SHA-256 is
  pinned in the installer and verified before extraction.
- The long-lived runtime key and tunnel ID are never stored in tracked files.

## Current Remote Acceptance State

External tunnel authorization and ChatGPT connector creation are complete. The independent Windows logon task is installed and the supervisor owns both the Computer-Use runtime and OpenAI Secure MCP Tunnel.

Remaining acceptance sequence:

1. Confirm one more fresh-chat read-only call after the session-resilience hardening.
2. Stop/disable RDC for the acceptance window.
3. Stop AWA only after Breakglass remains independently reachable with RDC absent.
4. Through the fresh Breakglass chat, run the AWA doctor and perform only the recovery action it authorizes.
5. Verify AWA returns healthy, then exercise bounded Git diff/commit/push on an acceptance branch.
6. Record receipts and restore the normal primary control plane.
## Acceptance Rule

Do **not** mark the overall RDC fallback as complete until the final test is
performed from a fresh ChatGPT conversation with RDC and AWA unavailable at the
start of the recovery sequence.