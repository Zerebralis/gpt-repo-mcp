# Host Breakglass Reliability / Known Failure Modes

This runbook records the two distinct reliability incidents found during RDC-retirement acceptance in September 2026. They can look similar from ChatGPT because both may surface as connector/tool failures, but they live at different layers and require different diagnosis.

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

### Durable fix

Commit `06be4f881e0ed9e0a8d4627d300477f1d1963fe3` added bounded pressure reclamation:

- the normal 10-minute idle TTL remains unchanged;
- only idle, non-in-flight sessions are eligible for early reclamation under capacity pressure;
- reservations that do not commit a session are released in `finally`;
- aggregate session telemetry is exposed through `/health` without exposing session IDs.

Do not "fix" this incident merely by increasing the pool limit. A larger pool only postpones exhaustion if lifecycle pressure is the underlying problem.

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

## Triage order

When Host Breakglass becomes unreliable, use this order instead of immediately restarting everything:

1. Check the local Host Breakglass `/health` aggregate session telemetry.
2. If sessions are at capacity and logs contain `session capacity reached`, diagnose **Failure mode A**.
3. Check the tunnel-client loopback `/readyz`.
4. Check `/metrics` and inspect `commands_poll_last_successful_timestamp_seconds`.
5. If `/readyz` is 200 but the poll timestamp is stale or absent, diagnose **Failure mode B**.
6. Inspect `%LOCALAPPDATA%\gpt-repo-host-breakglass\supervisor.log` and `connector-state.json` for the restart sequence.
7. Only after separating these failure modes investigate wider network/control-plane causes.

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
