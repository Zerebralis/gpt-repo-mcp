# Host Breakglass Architecture / Decision Log

Status: 2026-09-16

This file records durable architectural decisions for Host Breakglass. Operational incidents and recovery procedures remain in `HOST_BREAKGLASS_RELIABILITY.md`; implemented tool details and harvest candidates remain in `HOST_BREAKGLASS_TOOL_HARVEST.md`.

## Decisions — 2026-09-16

### Scope stays deliberately small

Host Breakglass remains a small, independent recovery layer. It is not an agent-orchestration, memory, planning, project-management, or product-review system. Those systems may use Breakglass, but Breakglass must remain independently usable when higher layers are unavailable.

### Structured primitives before free-form shell

When a stable bounded contract can represent an operation, prefer a structured Host Breakglass primitive over `host_shell`. Shell remains a deliberate breakglass escape hatch, not the default integration surface.

### Safe defaults remain the baseline

`mode=safe` and `full_host_access=false` remain the normal production posture. Broader authority must be explicit and exceptional rather than inherited by default.

### Reliability fixes address causes, not symptoms

Reliability incidents should be diagnosed and fixed at their failure mechanism. Do not mask them with larger limits, blanket restarts, or broad process termination unless evidence specifically justifies that action.

### Session saturation uses bounded headroom

The MCP session hard cap remains 100 and the default pressure idle TTL remains 60 seconds. Sustained Secure Tunnel churn is handled with pressure reclamation and a configurable soft target that defaults to 80% of `maxSessions`, rather than by merely enlarging the pool. Only pressure-old, idle, non-in-flight sessions are eligible for soft-target reclamation; fresh and in-flight sessions remain protected, and the hard cap remains strict.

### Tunnel liveness requires control-plane evidence

Local `/readyz` alone is insufficient proof that the remote control plane still sees the tunnel. Runtime supervision therefore also monitors freshness of `commands_poll_last_successful_timestamp_seconds` and treats a stale control-plane poll heartbeat as a distinct liveness failure.

### Tool growth must earn its place

The live Host Breakglass surface grew from 23 to 39 tools. New tools are accepted only when they provide demonstrated operational value, reduce brittle shell/GUI improvisation, improve safety, or materially reduce tunnel round-trips. Tool count is not a product goal.

## Explicitly not chosen

The following are not architectural defaults:

- Full Host Access by default.
- Blind or blanket restarting as a generic recovery strategy.
- Blanket session killing to create headroom.
- Raising `maxSessions` as the primary fix for session-lifecycle pressure.
- Expanding Breakglass into agent orchestration, memory, planning, project management, or unrelated feature surface.

## Open candidates — not yet decided

These remain candidates only and require separate evidence/review before adoption:

- a true PTY-backed interactive process primitive;
- persistent content-addressed change receipts with restart-safe explicit rollback;
- a second independently supported recovery transport/failover path;
- structured validation profiles for allowlisted repository-owned test/build/lint/typecheck/smoke commands;
- better composition of existing structured tools without expanding authority unnecessarily.

## Production baseline

The production baseline after the 2026-09-16 session-headroom acceptance is:

`main@47b0815ef0dae7ffce334fbe12970d0782846af9`

Session-headroom hardening is **LIVE ACCEPTED** at this baseline.

Do not store process IDs, transient session snapshots, tunnel identifiers, tokens, runtime API keys, or other credentials in this decision log.
