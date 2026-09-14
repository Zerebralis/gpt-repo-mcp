# Host Breakglass Acceptance — 2026-09-14

## Status

| Layer | Status | Evidence |
| --- | --- | --- |
| Separate Host MCP server | ACCEPTED locally | Normal Repo MCP remains separate; Host Breakglass exposes its own 23-tool surface. |
| Files / shell / processes / Git / Windows | ACCEPTED locally | Built MCP smoke passed file mutation, bounded shell, managed processes, Git commit + push to a temporary bare remote, stale-HEAD rejection, Windows processes, HKCU registry set/read/delete, services, and root policy. |
| GUI / Computer-Use | ACCEPTED locally | Pinned Computer-Use 7.1.0 `ax` runtime; GUI smoke passed catalog filtering, screenshot image passthrough, and mouse movement. |
| Independent lifecycle | IMPLEMENTED | Breakglass supervisor owns Computer-Use + Secure MCP Tunnel children with bounded restart backoff; Windows logon task installer is fail-closed. |
| OpenAI Secure MCP transport | PREPARED / AUTH BLOCKED | Official Windows tunnel-client 0.0.14 installed and checksum-verified; HTTPS/443 to OpenAI reachable. Tunnel ID and restricted Runtime API key are not configured yet. |
| AWA recovery rehearsal | ACCEPTED for diagnosis | AWA was discovered and inspected through Host Breakglass, its test/check chain was executed through Host Breakglass, and its host-runtime doctor was read through Host Breakglass. |
| Final RDC-off + AWA-off remote recovery | NOT RUN | Requires the OpenAI tunnel authorization and a ChatGPT Tunnel connector first. |

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

## Remaining External Authorization

Before the final remote failover test, the local ignored `host.env` needs:

```text
CONTROL_PLANE_TUNNEL_ID=  # set locally from OpenAI Platform Tunnels
CONTROL_PLANE_API_KEY=  # set locally to a restricted Runtime API key with Tunnels Read + Use
```

Do not use an Admin API key as the long-lived daemon key.

After those values are configured:

1. Run `npm run host:doctor` and require `ok=true`.
2. Install the independent Windows login task with `npm run host:autostart:install`.
3. Start or trigger the supervisor and verify its state is `running`, with both connector and Computer-Use child PIDs present.
4. In ChatGPT connector settings, choose the Tunnel connection and select the Breakglass tunnel.
5. Open a fresh chat and verify read-only Host Breakglass calls first.
6. Stop/disable RDC for the acceptance window.
7. Stop AWA only after the Breakglass connector remains independently reachable.
8. Through the new chat: inspect AWA, run the AWA doctor, perform only the recovery action the doctor authorizes, verify AWA returns, then exercise bounded Git diff/commit/push on an acceptance branch.
9. Record receipts and restore the normal primary control plane.

## Acceptance Rule

Do **not** mark the overall RDC fallback as complete until the final test is
performed from a fresh ChatGPT conversation with RDC and AWA unavailable at the
start of the recovery sequence.