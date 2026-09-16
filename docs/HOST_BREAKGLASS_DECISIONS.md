# Host Breakglass Architecture / Decision Log

Status: 2026-09-16

This file records durable architectural decisions for Host Breakglass. Operational incidents and recovery procedures remain in `HOST_BREAKGLASS_RELIABILITY.md`; implemented tool details remain in `HOST_BREAKGLASS_TOOL_HARVEST.md`.

# A. Durable architecture decisions

## Breakglass remains a small independent recovery layer

Host Breakglass is deliberately:

- independent;
- locally understandable;
- recovery-oriented;
- auditable;
- built around safe defaults.

It is not an agent platform, memory system, project manager, general automation framework, second AWA, second CoS, or second GPT Repo MCP. Other systems may use Breakglass, but Breakglass must not depend on them for its own ability to recover the host.

## Structured primitives before free-form shell

When a stable bounded contract can represent an action, prefer a structured primitive over free-form shell. `host_shell` remains an intentional breakglass escape hatch.

**Safe Mode is not a host sandbox.** Shell safety must not be presented as a sandbox merely by adding more regex rules. Structured primitives, explicit roots, allowlists, stale-state guards, and process-identity guards are preferred where practical.

## Safe defaults remain standard

The normal production posture remains:

- `mode=safe`;
- `full_host_access=false`;
- approved roots;
- allowlists;
- hash/stale-state guards;
- process-identity guards where possible.

Broader authority must be explicit and intentional.

## Reliability problems are fixed at the failure mechanism

Do not harden symptoms by merely increasing limits, blanket restarting, broad process killing, or blanket session killing. First identify the actual failure mode, then repair that mechanism.

## Session saturation uses headroom, not a larger pool

The former sticky `100/100` state was not solved by increasing `maxSessions`.

Durable session architecture:

- hard cap: 100;
- soft target: 80% by default;
- pressure idle TTL: 60 seconds by default;
- reclaim only pressure-old, idle, non-in-flight sessions;
- fresh and in-flight sessions remain protected;
- the hard cap remains strict;
- a periodic pressure sweep creates headroom even without a new admission.

This behavior is live-accepted on the real Secure Tunnel path.

## Tunnel liveness requires more than `/readyz`

Local readiness is not sufficient proof that the OpenAI control plane still sees the tunnel. A live process or `/readyz=200` must not be equated with a functioning control-plane connection.

The additional liveness signal is:

`commands_poll_last_successful_timestamp_seconds`

Its freshness is monitored by the Breakglass runtime.

## Tool growth must prove operational value

The Host Breakglass surface grew from 23 to 39 tools. Tool count is not a product goal, and 39 tools are not considered a problem by themselves when contracts remain clear and composition is good.

A new tool should provide at least one demonstrated benefit:

- simplify real recovery work;
- replace brittle shell/GUI improvisation;
- improve safety;
- reduce tunnel round-trips;
- make a concretely observed failure mode easier to diagnose or recover.

## Operation result and audit result are separate states

Durable decision since `main@5699550c42137ac5cdfa23855213aed663fe0f41`:

**An audit failure must never overwrite an already-known operation result.**

Therefore:

- success + audit failure remains operation success;
- operation failure + audit failure retains the original operation failure;
- audit failure is reported separately;
- audit failure alone does not justify retry;
- audit failure must not cause the operation to execute again;
- known side effects must not become an "unknown operation failure" merely because reporting/audit failed afterward.

This matters especially for mutations, where blind retry could duplicate side effects. The reviewed failure path demonstrated that a successful operation could previously be surfaced as a tool error solely because the following audit write failed.

## Mutations are not blindly retried

For mutating operations, first classify the observed state:

- operation definitely failed;
- operation definitely succeeded;
- side effect / outcome is uncertain.

Only clearly transient **read-only** failures are good candidates for bounded automatic retry. For mutations, establish actual state before deciding whether another operation is safe.

## Composition before more top-level tools

Further efficiency should first come from better composition of existing primitives:

- diagnostic batching;
- fixed read-only diagnostic profiles;
- shared budgets;
- correlated evidence.

Do not automatically add more top-level tools when composition solves the problem with the current surface.

## Stable Runtime / separate recovery artifact

Status: **IMPLEMENTED / LIVE ACCEPTED**.

Production runs the versioned release `host-breakglass-e27c0e2a4193-7b92c5ec65e1`, bound to:

- runtime commit: `e27c0e2a419361c72e2948868e71d9c6f7bfe322`;
- Git tree: `1bfb39666d3cc3311ab7cfd8eebd2aca73721ca5`;
- artifact SHA-256: `8EC5A18DC25DD682CF4FE22910383C483AFC80D48978AC2FF0EAB059637932AD`;
- manifest SHA-256: `7B92C5EC65E1CFFFEA515D370B8BBE3F825718141FF8824F5B57E4CD0BA02BD9`.

The regular release is materialized outside the development repository. Its manifest binds the clean source commit/tree, build dependencies, and all payload hashes. Core and GUI runtime code include their npm runtime dependencies; the release needs neither runtime `node_modules`, `NODE_PATH`, nor the development checkout to load and execute that code. Out-of-repository dependency isolation and production activation are verified.

Node and the explicitly provisioned Computer-Use and Tunnel runtimes remain external host dependencies. Host configuration, credentials, state, and audit storage remain separately provisioned inputs; their existing locations and contracts were not changed by packaging. Independence of release code does not imply relocation of these inputs.

The Scheduled Task starts the stable release with the existing user/security and configuration contract. A verified previous runtime and its complete task contract remain available for explicit rollback. Do not turn this release/activation path into a self-update system or package-management platform.

# B. Lifecycle status and remaining accepted direction

Implemented and live-accepted slices are identified explicitly below. Remaining architecture targets are **not** documented as production-complete.

## Failure-domain isolation / lifecycle decoupling

Failure-domain isolation is now partially implemented and live accepted:

- **GUI Failure Domain — IMPLEMENTED / LIVE ACCEPTED.** A GUI failure recycles only the GUI generation; Host Core and unrelated recovery capability remain available.
- **Tunnel Failure Domain — IMPLEMENTED / LIVE ACCEPTED.** A tunnel failure recycles only the connector-owned tunnel generation. Tunnel cleanup is bound to that generation through a Windows Job Object.
- During the productive tunnel live test, Host Core, Connector, GUI, and existing Managed Jobs remained intact while only the tunnel generation was replaced.
- Tunnel reconnect completed without MCP replay.
- **Core Functional Liveness — OPEN / NEXT.** Core functional health still needs an explicit independent liveness contract beyond process existence and transport health.

The architectural goal remains to minimize cross-domain lifecycle coupling and to preserve recovery work across failures whenever state is known to be safe.

## Bounded diagnostic profiles

Preferred direction: extend `host_diagnostics_batch` or compose existing primitives rather than building a macro/agent platform.

A possible `breakglass` profile should correlate, within bounded/redacted output:

- core status;
- tunnel/poll status;
- GUI status;
- Scheduled Task state;
- process identity;
- session telemetry;
- relevant bounded/redacted logs;
- partial failures as `unknown` / `unavailable`, never falsely `healthy`.

Use a shared time/response budget, bounded parallelism for local reads, and collect reusable process data only once. Do not solve this by granting broad AppData access.

Status: **PRIORITY #3 — not implemented**.

## Further runtime identity metadata

Stable release packaging and commit/artifact/manifest binding are implemented as recorded above. Additional tool-schema fingerprints and server/instance-generation identity remain future work; packaging acceptance does not claim those extensions.

# C. Deliberately not prioritized now

## True PTY

There is currently no demonstrated recurring recovery case blocked by missing PTY semantics. `host_process_start` + `host_process_input` covers the current line-oriented need. Revisit PTY only when a concrete real-world blocker appears.

## Validation Profiles in Breakglass

Do **not** duplicate repository validation workflows inside Breakglass by default. Test/build/lint/typecheck/smoke belong primarily to GPT Repo MCP / repository-owned workflows. Giving project code a profile name does not make execution inherently safe.

## General persistent receipt / rollback system

A general durable receipt-and-automatic-rollback subsystem is currently too large for Breakglass. If evidence later justifies it, first consider a small crash-state receipt containing only items such as operation ID, request hash, target paths, before/after hashes, and status. That would be state evidence, not automatic rollback.

## Automatic second remote transport

Not currently prioritized. A second tunnel adds maintenance and attack surface and does not fix a dead Node process or missing runtime artifact. A genuine backup path must remain reachable outside the failed path. Local OS recovery plus a reproducible recovery artifact has higher priority.

## Clipboard

Clipboard remains opt-in. It is not a default Breakglass capability unless recurring operational value justifies the secret-exposure risk.

## Recovery macro / agent framework

Do not build an app-specific recovery-agent framework into Breakglass. Fixed diagnostic profiles are acceptable; application-specific recovery logic belongs in AWA, CoS, or the responsible higher layer.

# D. Current production baseline

Current production runtime-code baseline (later documentation-only commits do not change the active artifact):

`e27c0e2a419361c72e2948868e71d9c6f7bfe322`

Production capabilities/decisions accepted at this baseline include:

- 39 tools;
- Safe Mode;
- `full_host_access=false`;
- control-plane poll watchdog;
- session pressure reclaim;
- 80% soft headroom;
- cumulative session telemetry;
- separation of operation result from audit result;
- GUI Failure Domain isolation — **IMPLEMENTED / LIVE ACCEPTED**;
- Tunnel Failure Domain isolation — **IMPLEMENTED / LIVE ACCEPTED**;
- Stable Runtime / separate recovery artifact — **IMPLEMENTED / LIVE ACCEPTED**;
- self-contained Core and GUI runtime npm dependencies with verified out-of-repository isolation;
- versioned production release bound to the commit and artifact/manifest hashes above;
- explicit verified rollback runtime and complete previous task contract retained;
- tunnel-generation cleanup through a generation-bound Windows Job Object;
- reconnect without MCP replay.

**Core Functional Liveness remains OPEN / NEXT.**

# E. Do not persist

Do not store in this Decision Log or durable Brain notes:

- process IDs;
- transient session counters;
- individual poll-age measurements;
- temporary ports;
- tunnel IDs;
- Runtime API keys;
- tokens;
- credentials;
- temporary cache/acceptance file paths.
