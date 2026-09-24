# Agent orchestration contract v1

This is a caller contract for the failure modes measured in the Host Breakglass audits of 2026-09-24: dependent execution after a refused write, equivalent retries through different executors, missing read batching, late blocker reporting, and long synchronous requests. It does not change authorization, shell policy, Full/Safe semantics, transports, sessions, the audit writer, or review routing.

## Enforcement and adoption

| Consumer | What it actually receives |
|---|---|
| `AgentToolSession` (`src/agent-orchestration.ts`) | Technical dependency, retry, batch, progress-event and job guards for calls dispatched through that instance |
| `scripts/smoke-host-breakglass.mjs` | Uses the adapter for its managed-job start/output flow; other smoke sections retain their existing purpose, including explicit negative tests |
| Host Breakglass MCP initialize | Full shared instructions from `src/orchestration/instructions.ts`; no server-side intent state |
| Repository MCP initialize | Short reference to this contract and an explicit prohibition on repackaging a denied effect; existing compact metadata budget retained |
| Hosted ChatGPT/Codex `functions.exec`, other tools, AWA, other harnesses | **Not technically intercepted by this repository.** Instructions apply where loaded; those runtimes must integrate an equivalent caller guard to claim technical enforcement. |

The adapter is an importable client library, built as `dist/agent-orchestration.js` with its adjacent build chunks and declarations. It is not a new daemon, MCP tool, server workflow engine, authority service, or persistent job platform. Creating an instance does not connect to any service. Importing the server instructions does not start its timer. Source changes do not deploy or update already running MCP servers.

## Required caller integration

Create one `AgentToolSession` per logical workflow, retain it across that workflow's tool cells, and close it at completion. Settled promises and full results are released; compact dependency/identity records and relevant denial history remain until the instance is discarded. All calls for a logical effect must use the same instance and the same normalized `intent` and `target`. These are **trusted integration inputs**: the adapter cannot infer semantic equivalence from arbitrary shell text, and renaming a target or recreating a session can defeat caller-side continuity. It is not a security boundary against a malicious caller; all original host/provider policies still execute.

```ts
const session = new AgentToolSession({
  availableTools: new Set(listed.tools.map(t => t.name)),
  dispatch: (request, { signal, timeoutMs }) =>
    client.callTool(request, undefined, { signal, timeout: timeoutMs }),
  onEvent: event => publishOperationalStatus(event),
  verifyChange: (operation, previous) =>
    verifyRecordedPrerequisiteChange(operation.change, previous)
});
try {
  await session.execute(writeOperation);
  // The adapter checks the stored outcome; callers cannot fabricate a successful parent.
  await session.execute({ ...executeOperation, dependsOn: [writeOperation.id] });
} finally {
  session.close();
}
```

`publishOperationalStatus` and `verifyRecordedPrerequisiteChange` above are integration hooks, not functions supplied by this package. A callback must not simply return an LLM-supplied approval boolean. The default without a verifier denies reconsideration. Operation IDs are immutable within the session; different payloads cannot reuse a successful receipt. Register dependencies before their children; unknown/forward dependencies are rejected rather than creating cycles. Independent operations can be submitted concurrently.

### REQUIRE_SUCCESS_BEFORE_DEPENDENT_ACTION

The adapter requires an explicit application `ok:true` contract, no MCP `isError`, no application failure, expected exit codes and specified required fields. Empty/malformed responses, `ok:false`, timeouts, failed terminal states, failed aggregate batches and missing required fields cannot satisfy dependencies. `Promise` fulfillment alone proves nothing. A separate audit-warning block preserves the original operation outcome and cannot trigger a mutation replay.

The decoder supports the repository/Breakglass JSON result envelope in MCP text or `structuredContent`. Other application-specific result contracts need an explicit adapter, not guessed success. `requiredFields` are top-level fields of the unwrapped result; success semantics beyond these generic signals belong in the caller's validated operation contract.

### SAFETY_FAIL_FAST / MAX_EQUIVALENT_RETRIES

Native codes are preferred for `UPSTREAM_AUTO_REVIEW`, `BACKEND_POLICY`, `LOCAL_EXEC_POLICY`, `TRANSPORT`, `ARGUMENT`, `AUTH`, `APPROVAL_PENDING`, `EXPECTED_REVIEW_BLOCKED`, `UNKNOWN`. Only the exact observed legacy rejection prefixes are recognized when native classification is absent or generic. Successful file contents are never scanned for rejection phrases. Unknown errors remain unknown.

The ledger keys the effect and target across executors. Syntax, operation ID and authorization labels alone cannot reset it. A policy failure suppresses the next equivalent attempt unless a trusted integration verifies a relevant new approval/capability condition. An approval change also requires a changed authorization revision. Even then the original policies are run again; success is not promised. After two policy denials the same effect/target path is closed for this session. No automatic retries are dispatched.

Argument/auth/approval changes are classified separately. A read-only transport failure allows at most two further caller-requested attempts with fresh verified transport evidence and a retryable result. An ambiguous mutating response cannot use that path. Concurrent equivalent effects are serialized by suppression, while unrelated work continues.

### STRUCTURED_TOOL_FIRST

For a known diagnosis/status operation, the trusted caller can provide `structuredAlternative` only after verifying complete semantic coverage and authorization. It is preferred when present in the supplied registry. The denial ledger is checked **before** selection, so this is not an automatic way around a refusal. No shell command is parsed into a different executable. Normal authorized shell calls remain supported.

Use existing specialized status tools where appropriate, including `host_review_runtime`; its routing and policy are unchanged. General natural-language tool selection remains an instruction for the hosted agent, not something this small library claims to solve.

### BATCH_WHEN_AVAILABLE

`readFiles` accepts independent known paths with explicit positive byte limits. It batches up to 20 files and 4 MiB only when the discovered `host_read_many` schema advertises `continue_on_error`. Detect that property from the current registry, not from an assumed version. The opt-in server mode retains one success/failure entry per attempted file; each read still passes the original path/authorization check. Default behavior remains fail-fast for old callers. Batch budget exhaustion is explicit and the adapter rejects incomplete aggregate results.

Member denials are retained by effect/path, including across a subsequent executor change. A group containing prior denials uses individual guarded calls so unrelated reads can continue. Without partial-result support or outside batch limits, bounded individual reads are used. A batch dependency does not pass if any member failed; callers can independently inspect successful member outcomes.

`diagnostics` uses the existing `host_diagnostics_batch` response (`operations`, `succeeded`, `failed`) with a maximum of 16 supported read operations. Managed `host_process_list` is **not** the `system_processes` OS diagnostic. Dependent/derived paths are not pre-batched; resolve a parent first, then explicitly dispatch its dependent child. Mutations are not accepted by these batch helpers.

Diagnostic members accept a caller-only `identity: {intent, target}`. Supply the same normalized identity used by equivalent `execute` calls, even when their executor differs. Without an explicit identity, the member uses the batch's `intent` and a target of `JSON.stringify([tool, argsWithSortedKeys])`; supported diagnostic arguments are flat scalar records. The batch's authorization revision and change evidence apply to each member. Identity metadata is stripped from the host request. Fresh independent members are reserved together; members with existing history use guarded singleton diagnostic batches through the same retry verifier, policy-block counter and busy/ambiguity checks as `execute`. A successful sibling does not inherit another member's denial.

Suppressed batch admission propagates the actual reason and releases member reservations without creating failures. Missing member results after an aggregate failure are reported as unavailable/incomplete; only the aggregate retains its attributable failure history. No individual denial is inferred from a lost aggregate response. A caller may retry an individual read-only diagnostic through its normal guarded contract; the adapter does not claim which members the host executed when their results are missing.

### PROGRESS_STALL_REPORTING

Each lane represents a logical subtask. The adapter immediately emits a blocker event on a returned hard failure. Events contain pseudonymized subtask/effect/target IDs, attempt count, error class, progress/blocker state, last successful evidence ID, changed/missing condition and next-action category. They contain no command, argument, approval text or response body. The host UI maps identifiers to approved human-readable labels and reports operational facts, never internal reasoning.

Reusing a lane updates its current effect/target without resetting elapsed time or evidence. Operation events carry their own effect/target, including late results from an earlier operation on that lane.

Use `progress.progress(subtask, evidenceId)` only for a new reliable finding/evidence/capability, completed mutation or relevant validation. Repeated evidence IDs and unchanged polls do not reset the clock. Use `progress.pause(subtask, true)` for approval waits, suspended/completed work or another announced workstream; resume with `false`. A separate blocked critical lane must remain visible. Managed jobs are paused automatically until reconciliation/completion.

A local instance timer checks active time every second: at 3 active minutes emit one `stall_check`; at 5 emit one `status_update`. A new evidence ID resets the escalation cycle. Blocker events are deduplicated until a meaningful escalation or state change. `onEvent` is synchronous and must deliver/queue promptly for the 60-second user-notice objective. Throwing delivery callbacks cannot corrupt tool bookkeeping; undelivered events can be recovered with `progress.drainUndelivered()`. Queue saturation blocks new operations; already admitted work can still finish. A reserved coalesced overflow receipt reports the number of events that could not be retained, rather than claiming lossless delivery. This library cannot guarantee a hosted UI renders an event. Always close the instance to stop its timer.

### LONG_RUNNING_OPERATION_AS_JOB

Set `longRunning:true` and supply an explicitly authorized `jobStart` using the existing `host_process_start` or `host_review_runtime`, with `host_process_output` available. A shell request declaring a timeout of 60 seconds or more also requires a job plan. No job plan means no dispatch. No automatic shell-to-process rewriting occurs, and approval arguments are neither invented nor expanded.

Request observation defaults to 30 seconds and is capped at 60 seconds. The injected dispatch must honor its abort signal/timeout; aborting observation does **not** prove cancellation of a side effect. Jobs return their ID immediately. `poll(id)` makes at most one status/output request after 5 seconds, then backs off to 10/20/30 seconds; early polls return the next eligible time without a toolcall. Do other work until that time. A running job is not a completed prerequisite. Terminal unsuccessful exits block dependent actions.

An uncertain start/response locks its effect against replacement starts. Known job IDs remain available for bounded output reconciliation. Missing/unknown IDs or terminal ambiguity never authorize a replacement. When no trustworthy job/result proof exists, resolve side effects outside this adapter with an authorized recovery procedure. There is intentionally no automatic unlock for an uncertain mutation. State is process-local: crash/restart recovery must reconcile externally retained job IDs and side effects before starting a new session. This change does not add a durable idempotency store.

A matching `job_id` with terminal `BLOCKED` is a known `EXPECTED_REVIEW_BLOCKED` failure. It releases the active job slot and pause, clears prior observation ambiguity, retains failure history and leaves dependent children suppressed. An already admitted poll can finalize this result after `close()`; it does not admit any new calls.

## State, capacity and terminal lifecycle

`pending` contains only admitted operations that have not settled. Its entry is removed in `finally` before the caller's returned promise settles. A completed operation keeps a SHA-256 operation-ID key, immutable request identity hash and a compact outcome (`status`, optional error class/reason, `result_retained:false`). No full `value`, shell arguments or fulfilled promise are stored in terminal history. The first caller and concurrent callers receive the full result; replay of an already completed identical ID returns only the compact receipt and never dispatches again. Keep needed result bodies in the caller's own explicitly bounded evidence store. Changed payloads under an old ID remain rejected. Dependencies use stored status, including after job completion, rather than promise fulfillment or retained payloads.

Successful intents with no earlier failure/retry history are removed after their active lease ends. Denials, unresolved mutations, active jobs, policy counts, consumed prerequisite-evidence hashes and transport retry counters remain for the whole logical workflow. A successful reconsideration does not erase earlier retry history. Read-batch members follow the same rule. Job identity and the minimal receipt remain available through `snapshot()` after close; active job plans are bounded by the job limit. `snapshot()` returns copies, not mutable internal state. It is trusted recovery data and can contain exact operation/job IDs; operational events only carry pseudonymized IDs.

The following independent admission/retention budgets are exported in `SESSION_LIMITS`. A trusted caller can lower individual limits via `limits`, but cannot raise them. Invalid configuration fails construction. These are client resource budgets, not changes to host authorization.

| Scope | Default | Purpose and recovery |
|---|---:|---|
| `in_flight` | 64 | Concurrent admitted executions, including dependency waits; wait for settlement, then resubmit an unadmitted operation |
| `jobs` | 32 | Active jobs plus start reservations; reconcile/finish known jobs by polling before admitting another |
| `active_intents` | 128 | Busy or job-owned intents, including batch members; wait for completion/reconciliation |
| `history` | 4,096 | Space reserved for live intents and retained failure/retry histories; clean successes release it; never evict unresolved history to admit new work |
| `terminal` | 100,000 | Compact ID/dependency receipts plus reservations for admitted operations; a metadata budget, not retained result payloads or an in-flight limit |
| `lanes` | 256 | Logical subtasks per workflow, not individual tool calls; reuse the correct lane, never invent a lane merely to reset its stall clock |
| `evidence` | 100,000 | Exact SHA-256 fingerprints across all lanes; no eviction that could turn old evidence into new progress |
| `event_queue` | 256 | Undelivered events; drain/restore the delivery consumer; one additional coalesced overflow receipt preserves loss visibility |

64 executions bound concurrent request observers; the smaller 32-job budget limits long-lived host work. 128 intent leases permit bounded batches alongside ordinary calls. The separate 4,096-entry reserve retains exceptional histories without retaining every successful intent. The two 100,000-entry budgets apply only to compact workflow metadata/digests, permitting the tested 10,000-call workflow with substantial headroom. They do not promise a precise RAM SLO, unlimited workflows or 100,000 arbitrary-size payloads in memory. `reported` blocker deduplication is retained for registered operations and their finite error/escalation states; it is indirectly bounded by these operation/history budgets rather than a separate 256-entry cache.

At 90% of a budget, emit one `capacity_warning`; at denied admission emit one `capacity_block` with `scope`, `used`, `limit` and `next_action`. Repeated blocks are deduplicated until capacity recovers. Admission returns `suppressed / WORKFLOW_CAPACITY:<scope>`; it neither dispatches nor silently evicts history. Queue backpressure is checked before new execute admissions. Evidence/lane APIs return `false` for controlled rejection rather than throwing on normal capacity exhaustion. Rejected evidence does not replace the last evidence, reset the clock or retroactively change an operation result. The caller must react to the capacity event instead of falsely treating rejected evidence as recorded progress.

Terminal metadata, exact evidence and lane/history limits have no in-session reset API. Their warning/block events require planning a real workflow completion. Finish/reconcile admitted work first, preserve required evidence externally and close the completed workflow. If the logical workflow cannot finish safely, stop and report the capacity blocker. **There is no automatic rollover or state-transfer protocol.** Creating a new session merely to renew capacity is not authorized recovery. In particular, unresolved denials, ambiguous effects and jobs cannot be forgotten at a boundary. No exactly-once guarantee across processes or sessions is claimed.

Lifecycle is `active → closing → closed`. `close()` synchronously stops all new admissions and the automatic stall timer, emits a closure/reconciliation event once and returns void for compatibility. Thereafter `execute`, `poll`, `readFiles` and `diagnostics` return `SESSION_CLOSED` without dispatch. No reopen exists. Queued but not dispatched operations and dependency/verifier waiters recheck lifecycle before dispatch. Already dispatched observations are allowed to settle under their existing timeout; close does not claim to cancel the host action. During that interval `snapshot().state` is `closing`. It becomes `closed` when those observations and batch bookkeeping settle.

Closing never clears job identities or ambiguous-intent markers. A late start response still records its job ID, and a late timeout still records mutation ambiguity. Inspect `snapshot()` after the admitted promises settle; known jobs and ambiguity require an authorized external reconciliation procedure because polling through a closed session is intentionally disabled. Closed means no new calls, **not** host work completed or safe to retry elsewhere. No durable recovery export/import is implemented: the integration must retain the instance or persist necessary IDs before discarding it. Once all external references are released after close, ordinary garbage collection can reclaim the instance. A callback/verifier supplied by the integration must itself settle; the adapter does not claim to cancel arbitrary caller callback code.

## Validation and scope

- `tests/agent-orchestration-r2.test.ts`: suppressed batch admission/recovery, member denial continuity across executors and verified changes, overlapping batches, unavailable aggregate results, terminal `BLOCKED` job capacity/close races and event identity on reused lanes. Dispatches use inert fixtures.

- `tests/agent-orchestration.test.ts`: T1–T9, native error classes, known-success audit warnings, changed prerequisites, concurrency, clock pauses/deduplication, timeouts, job reconciliation and batch-member denial retention.
- `tests/agent-orchestration-mcp.test.ts`: actual MCP initialize/schema/results, independent per-file errors and path-policy preservation, dependency suppression after a real rejected write, diagnostic result shape.
- `tests/agent-orchestration-lifecycle.test.ts`: 10,000 sequential operations, failure/dependency/ID preservation, large-result release, typed resource limits, >256 evidence items, queue backpressure, terminal close and late mutation/job/poll outcomes. All dispatches in these lifecycle tests are inert fixtures.
- Existing registry, tool-harvest, audit-result and instruction-size contracts remain relevant. Do not enlarge their budgets just to fit additional prose.

The acceptance claim is **implemented client enforcement for adopted callers plus shared instructions**. It is not global enforcement of the closed hosted `functions.exec` runtime and not a production deployment. Those are explicit adoption/deployment follow-ups, not hidden assumptions. Full/Safe mode, fallback permissions, fresh-context review requirements, Git operations, host process execution and all existing policy checks remain authoritative.

Residual from R2: `host_read_many.continue_on_error` can return raw exception messages, potentially containing paths. This fix does not sanitize or change that existing error contract; no HIGH secret-disclosure claim is established by that observation alone.
