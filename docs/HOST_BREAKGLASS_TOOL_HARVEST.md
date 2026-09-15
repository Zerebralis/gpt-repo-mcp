# Host Breakglass Tool Harvest

Status: 2026-09-15

Host Breakglass stays a focused recovery connector. The goal is not unrestricted host authority; it is to replace brittle shell/GUI improvisation with bounded, structured tools harvested from patterns already proven in GPT Repo MCP, Chat On Steroids, AWA, and the Computer-Use adapter.

## Design rules

- Keep `mode=safe` and `full_host_access=false` as the normal operating posture.
- Prefer structured tools over `host_shell` when a stable contract can represent the action.
- Read/observe broadly enough to diagnose; mutate only through explicit roots, allowlists, stale-state guards, or full-mode approval.
- Reduce MCP/tunnel round-trips for common diagnosis flows.
- Keep agent orchestration, memory, project planning, and product-level review out of Breakglass.

## P0 — implemented in this slice

### Fewer round-trips

- `host_read_many`: bounded multi-file reads, up to 20 files with a total byte cap.
- `host_diagnostics_batch`: up to 16 read-only diagnostics in one MCP call. Supported operations are system/process detail/tree, network listeners/port ownership, Scheduled Task reads, Event Log reads, loopback HTTP probes, path stat, and file hashing.

### Safer file mutation

- `host_apply_changes`: guarded text write/replace packs, dry-run support, per-file stale SHA-256 guards, expected-missing guards, preflight of all targets, and automatic best-effort rollback when a later apply step fails.
- `host_file_hash`: streaming SHA-256/SHA-512 without loading the full file into memory.

### Better managed-process interaction

- `host_process_input`: bounded stdin writes to jobs started by Breakglass, with optional stdin close. This intentionally is not advertised as a full PTY.

### Windows diagnosis and recovery

- `host_system_process_detail`: command line, executable path, creation time, protection role, and deterministic process identity hash.
- `host_system_process_tree`: root plus descendants with identity hashes.
- `host_system_process_kill.expected_identity_sha256`: optional stale/PID-reuse guard before termination.
- `host_network_listeners`: structured TCP/UDP listener inventory.
- `host_port_owner`: one-port ownership lookup enriched with process detail.
- `host_task_list` / `host_task_get`: structured Windows Scheduled Task inspection.
- `host_task_start` / `host_task_stop`: mutation only for `scheduled_tasks.allowlist` in safe mode; full mode still requires explicit full approval for non-allowlisted tasks.
- `host_eventlog_query`: bounded recent Windows Event Log slices with provider/event-id filters.
- `host_http_probe`: bounded health probe; safe mode restricts it to loopback so it cannot silently become a generic network client.

### GUI observation

- `host_window_observe`: one-call window metadata + accessibility tree + optional screenshot through the existing loopback Computer-Use adapter.

The Host Breakglass MCP surface is now 39 tools.

## P1 — next harvest candidates

1. **True PTY sessions**
   - Harvest the interaction model used by CoS (`exec_command` + `write_stdin`) but use a real pseudo-terminal backend rather than claiming pipes are a PTY.
   - Preserve bounded output, timeout, audit, and process-tree cleanup.

2. **Durable change receipts and explicit rollback**
   - Extend the P0 transactional apply with persisted content-addressed receipts, restart-safe rollback, and expiry/cleanup.
   - Borrow stale-state and receipt concepts from GPT Repo MCP patchsets without importing its product/delegation layer.

3. **Structured validation profiles**
   - A host-level `validate` primitive for allowlisted repository-owned `test/build/lint/typecheck/smoke` commands.
   - No arbitrary command strings in the validation contract.

4. **Diagnostic read roots/profile**
   - Add purpose-specific diagnostic roots for AWA/CoS/Breakglass state and logs rather than broadening `full_host_access`.
   - Keep credential/token paths denied.

5. **Clipboard as an explicit capability**
   - Computer-Use already supplies `read_clipboard` and `write_clipboard`; keep them opt-in because clipboard contents can contain credentials.

## P2 — useful, but keep out of the critical recovery core until justified

- DNS / routing / interface summaries beyond current listener and HTTP health diagnostics.
- Event-log correlation helpers and known-incident recipes.
- App-specific recovery macros built from structured primitives.
- Secondary transport health/failover orchestration after the OpenAI Secure Tunnel path is stable.

## Explicit non-goals

Do not harvest CoS/AWA agent spawning, conversation memory, planning, repository product review, semantic review, or delegation workflows into Host Breakglass. Those systems can use Breakglass; Breakglass should remain the small independent layer that can repair them.
