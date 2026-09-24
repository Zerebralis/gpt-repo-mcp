# Host Breakglass Reliability / Known Failure Modes

This runbook records the two distinct reliability incidents found during RDC-retirement acceptance in September 2026. They can look similar from ChatGPT because both may surface as connector/tool failures, but they live at different layers and require different diagnosis.

## Operator role as of 2026-09-24

In Markus' host stack, Host Breakglass is no longer the default generic PC transport. The default for routine ChatGPT-to-Windows work is **Windows MCP** (CursorTouch Windows-MCP over the OpenAI Secure MCP Tunnel).

Host Breakglass remains intentionally live as a **specialist and fallback layer** for Breakglass-specific capabilities such as the Review Runtime, structured Git/diagnostic/recovery paths, richer typed host evidence, or a capability that Windows MCP does not expose appropriately. It is also the fallback when the Windows-MCP path itself is unavailable.

This is a caller/operator routing decision, not a deprecation of the server and not a change to Breakglass Full/Safe semantics. When Breakglass is selected, its existing policy remains authoritative. A refusal or platform safety block on Windows MCP is not permission to reconstruct the same operation through Breakglass merely to bypass that refusal.

Live A/B and recovery checks on 2026-09-24 found Windows MCP materially faster for desktop snapshots and screenshots, faster for process listing and typical shell calls, and roughly comparable for simple file reads. A mixed 12-call burst passed 12/12; file write/read/delete, app launch, UI input and automatic server/tunnel crash recovery were also verified. These observations justify the routing change but do not justify deleting Breakglass or removing its specialist capabilities.

## Failure mode A: MCP session-capacity exhaustion

### External symptom

Host Breakglass tool calls intermittently fail with gateway/upstream errors, commonly surfaced as HTTP 502.

### Local signature

The Host Breakglass server log contains a diagnostic like:

```text
host-breakglass MCP session capacity reached active=100 max=100
```

`/health` reports the session pool at or near capacity.

### Root cause

ChatGPT Secure Tunnel workflows can create many short-lived MCP Streamable HTTP sessions. Under sustained parallel activity, idle sessions accumulated faster than the normal 10-minute idle TTL released them. Once all 100 slots were occupied, new MCP session initialization was rejected locally. The connector/gateway could then surface that local refusal as an upstream 502.

### Durable fix and headroom hardening

Commit `06be4f881e0ed9e0a8d4627d300477f1d1963fe3` added the first bounded pressure reclamation:

- the normal 10-minute idle TTL remains unchanged;
- only idle, non-in-flight sessions are eligible for early reclamation under capacity pressure;
- reservations that do not commit a session are released in `finally`;
- aggregate session telemetry is exposed through `/health` without exposing session IDs.

The later session-headroom hardening addresses the sticky `100/100` pattern seen during sustained Secure Tunnel churn. The hard cap remains 100 and the pressure idle TTL remains 60 seconds by default, but pressure reclamation now has a configurable soft target. `GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET` defaults to 80% of the hard cap (80 sessions at the default cap).

- admission pressure reclaims pressure-old, idle, non-in-flight sessions far enough toward the soft target to leave room for the pending admission;
- the periodic cleanup loop also pressure-sweeps eligible sessions toward the soft target, so headroom can recover without waiting for the next admission;
- fresh sessions and in-flight sessions are never closed merely to hit the soft target;
- if recent or in-flight sessions fill the hard cap, the hard cap still wins and the new admission is rejected;
- `/health` retains point-in-time pool telemetry and adds cumulative process-lifetime counters for committed sessions, normal expirations, pressure reclaims, and admission rejections.

Do not "fix" this incident merely by increasing the pool limit. A larger pool only postpones exhaustion if lifecycle pressure is the underlying problem. Likewise, `active == capacity` is not sufficient by itself to prove a failure: distinguish a pool that is still reclaiming and admitting from one that is actually rejecting admissions.

### Follow-up incident: session continuity vs. hard-cap saturation — 2026-09-18

A later parallel-agent incident exposed a second failure mode in the same session pool. Multiple chats intermittently saw generic `Connection failed` errors while all local Breakglass process identities remained stable, `/health` stayed HTTP 200, the tunnel generation remained `ready`, and the tunnel loopback `/readyz` stayed 200.

The production pool repeatedly sat at the old soft target of 80 sessions with a large reclaimable idle cohort and thousands of cumulative pressure reclaims. The old policy used the same value as both the pressure trigger and the cleanup target, and considered a session pressure-old after only 60 seconds. Under sustained parallel ChatGPT activity, every new admission above 80 could therefore be paid for by closing another idle 60+-second session. A chat that later reused that session could surface a generic connector failure even though the tunnel process itself never restarted.

This correlation is strong but the pre-fix runtime did not retain enough retirement provenance to prove which exact missing session had been pressure-reclaimed.

The first continuity hotfix tried to preserve sessions much longer (8-minute pressure TTL, soft target 90, high watermark 95). It passed deterministic and R2 review, but **failed live acceptance** under real parallel-agent reconnect load: the pool filled to `100/100` and emitted sustained `MCP session capacity reached` rejections. It was rolled back to Stable. This proved that long blanket retention is not viable on the real workload.

The live failure sharpened the protocol boundary: reclaim is required to keep the bounded pool healthy. The stale-session path must instead be explicit and recoverable: an unknown/retired `Mcp-Session-Id` returns protocol-correct 404 rather than the former 400.

Refined V2 policy:

- normal idle expiry remains unchanged at 10 minutes by default;
- ordinary pressure age is 60 seconds so sustained churn cannot pin the pool at the hard cap;
- pressure cleanup uses hysteresis: default soft target 80 sessions, default high watermark 90 sessions;
- periodic cleanup does nothing at or below 90;
- when a new admission would cross 90, only pressure-old, idle, non-in-flight sessions are reclaimed toward 80;
- Host Breakglass additionally opts into hard-cap emergency reclaim: if the pool reaches 100 before any session is pressure-old, the oldest idle/non-in-flight sessions are reclaimed only far enough to restore high-watermark headroom; if all capacity is genuinely in-flight/reserved, the new admission is rejected;
- bounded in-memory retirement provenance distinguishes later reuse attempts after pressure reclaim, emergency reclaim, normal expiry, and unknown-session misses without exposing session IDs; the provenance cache is capped at `4 * maxSessions` entries (minimum 32) and evicts oldest retirement markers first;
- `/health` exposes the high watermark and cumulative pressure/emergency reclaim and reuse/miss counters;
- protocol recovery is corrected: requests that carry an unknown/retired `Mcp-Session-Id` return HTTP **404 `Session not found`**, as required by the Streamable HTTP session contract; only non-initialization requests with no session ID return HTTP 400. This gives an MCP client/gateway the correct signal that it must establish a new session instead of treating the request itself as malformed.

Relevant defaults:

```text
GPT_HOST_BREAKGLASS_MAX_SESSIONS=100
GPT_HOST_BREAKGLASS_SESSION_IDLE_TTL_MS=600000
GPT_HOST_BREAKGLASS_SESSION_PRESSURE_IDLE_TTL_MS=60000
GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET=80
GPT_HOST_BREAKGLASS_SESSION_PRESSURE_HIGH_WATERMARK=90
```

Validation now includes both a sustained-churn HTTP test and a cold-reconnect-burst test. The cold-burst case fills the pool with sessions that are still younger than the ordinary pressure TTL, then proves Host Breakglass can recover idle headroom without a 503 and that a retired session subsequently receives protocol-correct 404.

Operationally, a single generic `Connection failed` must not be called a tunnel failure unless tunnel state or poll-readiness evidence actually degraded. A mutating request must never be blindly replayed after an ambiguous connection failure; reconcile state first.

## Failure mode B: tunnel is locally ready but invisible to the control plane

### External symptom

The connector/gateway returns errors such as:

```text
tunnel_client_not_seen
Tunnel-client has not been seen for 300 seconds
```

Gateway 404s can occur even though the local tunnel-client process still exists. Reconnect storms may additionally produce 429 responses.

### Critical distinction

A successful local `GET /readyz` is not sufficient evidence that the OpenAI control plane is still seeing the tunnel-client.

This exact failure was observed with:

- tunnel-client process alive;
- local `/readyz` returning 200;
- local readiness metric equal to 1;
- remote connector path nevertheless reporting `tunnel_client_not_seen`.

The stronger liveness signal is the tunnel-client v0.0.14 metric:

```text
commands_poll_last_successful_timestamp_seconds
```

It records the Unix timestamp of the most recent successful control-plane poll, including a successful empty poll. If this timestamp stops advancing, the client can be locally alive/ready while the gateway eventually considers it absent.

### Root-cause boundary

The incident proved a supervision gap: the Breakglass lifecycle previously watched process existence and later `/readyz`, but not continued successful control-plane polling. Therefore a wedged or disconnected poll loop could remain alive indefinitely from the local supervisor's point of view.

The evidence does **not** by itself prove why the poll loop stopped (for example local networking, an upstream/control-plane condition, or a tunnel-client fault). The durable repair is therefore self-healing supervision of the externally meaningful poll heartbeat rather than an unsupported claim about the upstream trigger.

### Durable fix

The connector now combines two health layers:

1. local tunnel readiness (`/readyz`), and
2. freshness of `commands_poll_last_successful_timestamp_seconds` from the loopback `/metrics` endpoint.

Startup does not declare the Secure Tunnel ready until at least one successful control-plane poll has been observed. Runtime supervision treats a stale poll heartbeat as unhealthy even when `/readyz` still returns 200 and cycles only the connector-owned tunnel child. The existing supervisor then rebuilds the Breakglass connector stack with bounded backoff.

Defaults:

```text
GPT_HOST_BREAKGLASS_TUNNEL_POLL_STARTUP_TIMEOUT_MS=90000
GPT_HOST_BREAKGLASS_TUNNEL_POLL_STALE_MS=180000
```

The existing watchdog probes every 10 seconds and trips after three consecutive failures. With a 180-second stale threshold, a stale poll loop is therefore normally recycled by about 210 seconds after the last successful poll, before the observed 300-second `tunnel_client_not_seen` condition.

`host-breakglass-doctor.mjs` also reports a live `control_plane_poll` check, including freshness and poll age but no tunnel credentials or IDs.

## Failure mode C: managed output observation is unavailable while the job continues

### External symptom

`host_process_output(job_id)` can fail with an MCP/tunnel/transport-level error such as `UNAVAILABLE` even though the managed process itself is still alive.

### Fault-isolation result — 2026-09-21

A controlled fault was injected after the Process Manager had successfully looked up a running job but before the caller could rely on the observation result. The same manager retained exactly one job with the same job ID and PID, the job remained `running`, and the same job later reached `exited` with the correct exit code. This isolates the gap above the process lifecycle itself: an observation/transport failure does not mutate or prove loss of the managed job.

### Recovery contract

- A failed `host_process_output` call is **indeterminate observation**, never evidence of process termination and never sufficient reason to start a replacement.
- Reconcile the **same job ID** with `host_process_list({ job_id })`. This is one bounded manager-state lookup; it does not start, poll, retry, or kill anything.
- `found=true, manager_state=running` means continue observing that same managed job. Do not duplicate it.
- `found=true, manager_state=terminal` preserves the manager's recorded terminal status/exit code for that same job identity.
- `found=false, manager_state=unknown` means only that the current manager has no record for the job ID. It is **not** proof that an OS process ended. Core restart still loses in-memory job handles.
- Never re-associate a managed job from PID alone. PID values may be reused; if separate OS-process evidence is needed, use the process-detail identity guard rather than adopting a PID as a managed job.
- Recovery contains no automatic retry loop and never automatically replays `host_process_start`. Any later replacement is a new explicit decision after terminal/loss evidence is established.

## Failure mode D: session-local connector / tool-registry binding loss

### External symptom

A connector namespace or part of its tool surface was previously available and used successfully in one ChatGPT conversation, then disappears from the tool registry for that same conversation. Direct and generic/deferred discovery no longer expose the expected tools there.

This is **not** the same as a stale MCP session and is **not** evidence that the Host Breakglass server, Secure Tunnel, or host runtime is down.

### Confirmed evidence boundary — 2026-09-21/22

Two real incidents established the failure shape:

- a long-running chat used Host Breakglass successfully and later no longer exposed the `Host_Breakglass` namespace while fresh/parallel chats still reached the same Breakglass runtime;
- a later GCR-7 session lost only parts of previously available connector/tool surfaces, while a fresh takeover session later continued against the healthy runtime without rebuilding it.

During BG-R1d implementation on 2026-09-22 the class reproduced again with a different connector: a GitHub connector namespace that had just been used successfully disappeared from the same session registry while Host Breakglass remained callable. A contemporaneous Breakglass `/health` snapshot stayed HTTP 200 on the production release, exposed 41 pre-BG-R1d tools, and showed no retired-session reuse or unknown-session miss explaining the registry disappearance. This cross-connector observation strengthens the classification boundary but still does **not** prove a specific ChatGPT platform root cause.

The same live registry snapshot also exposed only **39** Host Breakglass tool names while that exact backend reported **41**. The missing names were newer tools (`host_http_request` and `host_review_runtime`), while older tools such as `host_list_roots`, `host_shell` and `host_git` remained visible and callable. This is direct evidence that the affected chat can hold a **stale/partial tool registry view** even while calls to older names still reach the current healthy backend. BG-R1d therefore carries current backend instance/tool-count evidence on the long-lived `host_list_roots` handshake itself; recovery must not depend exclusively on discovering the newer `host_connection_snapshot` tool.

### Backend-only snapshot

`host_connection_snapshot` provides bounded evidence that survives ordinary MCP session churn:

- stable Breakglass `instance_id` and `started_at` for the current server process;
- mode, PID, tool count and Computer-Use enablement;
- the same aggregate MCP session counters exposed by `/health`;
- bounded managed-process summary plus currently running managed `job_id` values;
- an explicit `chat_binding.observable=false` marker.

The snapshot deliberately says `scope=host-breakglass-backend-only`. A healthy snapshot cannot prove that a particular ChatGPT conversation still has the connector registered. Conversely, a missing connector surface means the affected conversation cannot call the snapshot itself; obtain fresh-context/rebind evidence instead.

### Deterministic classification

The optional incident input on `host_connection_snapshot` implements the same fail-safe matrix as this runbook:

| Evidence | Classification | Local restart |
|---|---|---|
| current attachment handshake succeeds | `healthy` | no |
| connector previously worked; direct/deferred rediscovery is now missing in that chat; fresh context/rebind successfully handshakes with Breakglass | `connector_binding_lost` | **no** |
| connector surface is present and backend returns protocol-correct `404 Session not found` | `mcp_session_stale` | no |
| independent backend health is unhealthy and neither current nor fresh context handshakes | `backend_or_transport_unavailable` | not automatic; diagnose first |
| missing/contradictory evidence | `inconclusive` | **no** |

A missing tool surface by itself is intentionally insufficient to classify `connector_binding_lost`. The classifier also fails closed on contradictory observations. `incident_analysis.evidence_source=caller_supplied_incident_observations` makes the trust boundary explicit; `independent_backend_health` is an input observation, not something inferred from the affected chat's missing registry.

### Recovery contract

For `connector_binding_lost`:

1. do not restart Host Breakglass, its tunnel, AWA, CoS, or the host merely because the current chat lost the namespace;
2. do not replay a mutating request whose outcome is ambiguous;
3. preserve any managed `job_id` already returned to the chat;
4. use generic/deferred discovery, then the intended connector rebind or a fresh ChatGPT context as the cheapest independent recovery test;
5. if the fresh context reaches Breakglass, continue on the same backend instance when possible and reconcile existing managed work by job ID before any replacement start;
6. only if a fresh context also cannot reach Breakglass escalate to the independent AWA/host/tunnel diagnostic path;
7. CoS is not an automatic recovery path.

The exact platform cause remains `unknown` until independently reproduced at the ChatGPT/tool-router layer. Host Breakglass can harden observation and recovery semantics; it cannot claim to repair a client-side registry implementation it does not control.

### Fault-lab acceptance

BG-R1d regression coverage must keep these states distinct:

- current surface missing + previous success + fresh-context handshake PASS -> `connector_binding_lost`;
- current surface present + `Session not found` -> `mcp_session_stale`;
- independent backend unhealthy + current/fresh transport failure -> `backend_or_transport_unavailable`;
- current surface missing without fresh-context proof -> `inconclusive`;
- contradictory evidence -> `inconclusive`;
- none of these classifications may authorize an automatic local restart or duplicate `host_process_start`.

## Triage order

When Host Breakglass becomes unreliable, use this order instead of immediately restarting everything:

1. First determine whether the expected `host_*` surface is still present in the affected ChatGPT context.
2. If the surface disappeared after previous successful use, run direct plus generic/deferred discovery. Do not restart anything yet.
3. If it remains missing, use the intended connector rebind or a fresh context. If that fresh context completes the attachment handshake, classify **Failure mode D / `connector_binding_lost`** and continue without rebuilding the local runtime.
4. If the connector surface is present but an existing MCP session returns `404 Session not found`, classify the stale-session path under **Failure mode A** and establish a fresh MCP session; do not duplicate managed work.
5. If current/fresh contexts still cannot reach Breakglass, inspect independent local `/health` evidence or `host_connection_snapshot` from an available context. Preserve any known managed `job_id` values.
6. If sessions are at capacity and logs contain `session capacity reached`, diagnose **Failure mode A**.
7. Check the tunnel-client loopback `/readyz`, then `/metrics` and `commands_poll_last_successful_timestamp_seconds`.
8. If `/readyz` is 200 but the poll timestamp is stale or absent, diagnose **Failure mode B**.
9. Inspect `%LOCALAPPDATA%\gpt-repo-host-breakglass\supervisor.log` and `connector-state.json` for the restart sequence.
10. Only after the fresh-context and backend/tunnel checks fail should AWA/host diagnosis consider a local runtime restart. CoS is not part of this automatic recovery path.

## Safety / lifecycle boundaries

- The Breakglass stack remains independent of AWA and RDC.
- Recovery must not kill Chat On Steroids or unrelated `tunnel-client.exe` instances.
- The tunnel health URL is generated locally and must remain loopback-only.
- Tunnel IDs, Runtime API keys, and other credentials must never be copied into tracked diagnostics or Brain notes.
- A watchdog recycle is a recovery mechanism. Repeated recycling is evidence of an unresolved upstream/local transport problem and should be investigated rather than hidden.

## Live acceptance — 2026-09-16

Breakglass-v2 was live-accepted on branch `feat/host-breakglass-tool-harvest-v2` at commit `b7108cf20dc7bac081716aebd95fe38e7fa6f0d4` over the production connector path `ChatGPT -> OpenAI Gateway -> Secure MCP Tunnel -> Host Breakglass`.

The live surface reported 39 tools. The P0 acceptance matrix passed, including the new structured diagnostics and change-pack dry-run path. `host_apply_changes` was used only with `dry_run=true`; its expected-missing temporary target remained absent afterward. The connector was in Safe Mode with `full_host_access=false`. The control-plane poll heartbeat was fresh, and the stable supervisor/launcher/server/tunnel process identities showed no restart loop during acceptance.

Session telemetry must be interpreted as load evidence rather than a single health score. During the formal acceptance run the pool reached 93/100 active sessions with 77 reclaimable under pressure. In the immediate closure follow-up it reached 100/100, but roughly 78–87 sessions remained reclaimable, reservations remained zero, in-flight work stayed low, and new requests continued to be admitted. The oldest idle cohort moved downward as calls continued, consistent with pressure reclamation removing eligible idle sessions on demand. This is not the earlier hard-saturation signature by itself; recurring admission failures or `session capacity reached` diagnostics would be the stronger failure evidence.

No credentials, tunnel IDs, tokens, or other secret material are recorded in this acceptance note.

## Verification evidence

For the poll-liveness hardening, verification included:

- a live tunnel-client v0.0.14 `/metrics` observation confirming the poll timestamp metric;
- live Doctor result `control_plane_poll: fresh`;
- unit coverage for normal and scientific-notation Prometheus gauge values, freshness boundaries, loopback-only health URLs, and metric probing;
- the existing readiness-watchdog tests;
- session-store and Host Breakglass policy regression tests;
- lint, TypeScript typecheck, build, public-hygiene check, and `git diff --check`.

For the v2 tool-harvest acceptance on 2026-09-16, the live connector path additionally verified the 39-tool surface, structured read/diagnostic tools, Safe Mode boundaries, fresh control-plane polling, stable process identities, and a non-mutating `host_apply_changes` dry run.

Keep this document as the first reference when future Breakglass incidents resemble 502, 404, or `tunnel_client_not_seen` failures.


## BG-R1d follow-up: tool-name registry integrity

The attachment handshake proves reachability, not that a particular client has the complete current tool catalog. A client can call `host_list_roots` successfully while exposing fewer tools or older input schemas. This follow-up adds bounded diagnostics; it does **not** claim to repair an external connector router or to prove that session reclamation causes catalog loss.

`host_list_roots` now includes `backend_attachment.tool_manifest`; `host_connection_snapshot` includes `backend.tool_manifest`. Both contain the same manifest:

- `scope: "tool_names_only"`;
- `tool_count` and lexically sorted unique `tool_names`;
- `tool_names_sha256`: SHA-256 of UTF-8 `JSON.stringify(sortedNames)` (no whitespace or trailing newline).

The normal surface remains 42 tools. The manifest is checked against real MCP `tools/list` registration in a contract test. It deliberately does not attest input schemas, descriptions, permissions, review/publication state, or the freshness of platform metadata. An equal count alone is insufficient: different name sets have different fingerprints.

For an explicit comparison, a caller can supply `incident.current_tool_snapshot` to `host_connection_snapshot`:

```json
{
  "backend_instance_id": "00000000-0000-4000-8000-000000000001",
  "inventory_complete": true,
  "tool_count": 39,
  "tool_names_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The example identifiers and hash are placeholders. Obtain the real instance identity from a successful current handshake and calculate the hash from an actually complete connector inventory. A filtered/deferred subset is not a complete inventory. The observation must describe the affected current context, not an independent control session. Caller observations remain untrusted diagnostic evidence and never grant authority.

With a successful current handshake, a complete name-set mismatch bound to this live backend returns `capability_registry_mismatch`, `restart_local_runtime: false`, and `replay_mutation: false`. Incomplete, contradictory or differently bound observations return `inconclusive`. Without a tool snapshot the legacy handshake classification remains compatible, but reports `registry_integrity: "not_observed"`; it is not a complete-capability health claim. Matching names report `matched_names`, not schema/permission freshness.

### Distinguish metadata maintenance from session loss

Check the connector's supported metadata lifecycle before attributing a partial list to MCP pressure. OpenAI documents separate developer-mode refresh and published-tool review flows:

- Developer-mode connections: refresh the connection's metadata, verify the advertised change, and test in a new conversation. A healthy, already-updated backend does not need a restart merely to refresh client metadata.
- Published plugins: the live server and published definitions are distinct. New tools can be held for checks; changed tools can retain their previous definition until checks finish. Diagnose the actual publication/permission state instead of treating every subset as an MCP session defect.

Primary references, checked 2026-09-22:

- <https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata>
- <https://developers.openai.com/plugins/deploy/app-review#how-published-mcp-metadata-versions-work>

These documented possibilities do not prove which state applies to a specific connection. A full namespace disappearance, a single platform-denied tool request, stale protocol session rejection, and an older published catalog are separate observations; do not collapse them into one root cause.

### Bounded investigation and recovery

Record UTC checkpoints with a diagnostic run identifier, the observed inventory source/completeness, name-set hash, live instance/start identity, Full-mode state, session/reclaim counters, and independent tunnel readiness plus control-plane polling freshness. State which operation just completed and which is next. Preserve last-good/first-bad evidence; if the first observation is already partial, there is no demonstrated full-to-partial transition in that run.

A direct fresh loopback MCP client is a useful same-backend control but is **not** a fresh ChatGPT context and cannot verify the platform's catalog refresh behavior. Terminate only the diagnostic MCP session after use. Do not expose its session identifier, credentials, prompts, provider output, or unrelated host data in evidence.

The isolated HTTP regression suite covers low-pressure parallel clients, soft-target/high-watermark pressure reclamation, normal expiry, fresh initialization and stable complete manifests. A confirmed append is followed by a rejected stale-session append; the file remains unchanged through reinitialization. This proves the tested backend does not dispatch that rejected operation or replay it on rebind. It does not prove that an unobservable external client will never independently retry a mutation.

On an uncertain mutating result, reconcile the existing managed job/operation and postcondition before proceeding. Never change session limits, restart the runtime/tunnel, refresh permissions, or replay work merely because a catalog is partial. Use only explicitly authorized metadata maintenance, and verify it with a new client context without claiming that this repairs an unknown upstream root cause.
