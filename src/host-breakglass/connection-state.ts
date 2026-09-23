import { createHash, randomUUID } from "node:crypto";
import type { HostBreakglassConfig } from "./config.js";
import type { HostProcessManager } from "./process-manager.js";

export type HostSessionSnapshot = {
  active: number;
  reservations: number;
  in_flight: number;
  reclaimable_under_pressure: number;
  oldest_idle_ms: number | null;
  cumulative: {
    committed: number;
    normal_expired: number;
    pressure_reclaimed: number;
    emergency_reclaimed: number;
    admission_rejected: number;
    pressure_reclaim_reuse_attempts: number;
    emergency_reclaim_reuse_attempts: number;
    normal_expiry_reuse_attempts: number;
    unknown_session_misses: number;
  };
  capacity: number;
  soft_target: number;
  pressure_high_watermark: number;
  idle_ttl_ms: number;
  pressure_idle_ttl_ms: number;
};

export type HostConnectionState = {
  instance_id: string;
  started_at: string;
  session_snapshot?: () => HostSessionSnapshot;
};

export type ToolNameManifest = {
  scope: "tool_names_only";
  tool_count: number;
  tool_names_sha256: string;
  tool_names: readonly string[];
};

export type CurrentToolSnapshot = {
  backend_instance_id: string;
  inventory_complete: boolean;
  tool_count: number;
  tool_names_sha256: string;
};

type LiveToolIdentity = Pick<ToolNameManifest, "tool_count" | "tool_names_sha256"> & { instance_id: string };

/** Names only: this fingerprint does not attest schemas, descriptions or app permissions. */
export function createToolNameManifest(names: readonly string[]): ToolNameManifest {
  const sorted = [...names].sort();
  if (sorted.length > 256 || new Set(sorted).size !== sorted.length
    || sorted.some((name) => !/^host_[a-z0-9_]{1,80}$/.test(name))) {
    throw new Error("Invalid Host Breakglass tool-name manifest");
  }
  return Object.freeze({
    scope: "tool_names_only" as const,
    tool_count: sorted.length,
    tool_names_sha256: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"),
    tool_names: Object.freeze(sorted)
  });
}

function registryIntegrity(observed: CurrentToolSnapshot | undefined, live: LiveToolIdentity | undefined) {
  if (!observed) return "not_observed" as const;
  if (!live || observed.inventory_complete !== true) return "unverified" as const;
  if (observed.backend_instance_id !== live.instance_id) return "attachment_mismatch" as const;
  if (!Number.isSafeInteger(observed.tool_count) || observed.tool_count < 0 || observed.tool_count > 256
    || !/^[a-f0-9]{64}$/.test(observed.tool_names_sha256)) return "invalid_observation" as const;
  const hashMatches = observed.tool_names_sha256 === live.tool_names_sha256;
  const countMatches = observed.tool_count === live.tool_count;
  if (hashMatches && !countMatches) return "contradictory" as const;
  return hashMatches && countMatches ? "matched_names" as const : "mismatch" as const;
}

export type ConnectorIncidentEvidence = {
  previous_success_in_current_context: boolean;
  current_registry: "available" | "missing_after_rediscovery" | "unknown";
  current_handshake: "ok" | "session_not_found" | "transport_error" | "not_attempted";
  fresh_registry: "available" | "missing_after_rediscovery" | "unknown";
  fresh_handshake: "ok" | "session_not_found" | "transport_error" | "not_attempted";
  independent_backend_health: "healthy" | "unhealthy" | "unknown";
  current_tool_snapshot?: CurrentToolSnapshot;
};

export type ConnectorIncidentClassification =
  | "healthy"
  | "connector_binding_lost"
  | "capability_registry_mismatch"
  | "mcp_session_stale"
  | "backend_or_transport_unavailable"
  | "inconclusive";

export function createHostConnectionState(): HostConnectionState {
  return {
    instance_id: randomUUID(),
    started_at: new Date().toISOString()
  };
}

export function classifyConnectorIncident(evidence: ConnectorIncidentEvidence, liveTools?: LiveToolIdentity) {
  const integrity = registryIntegrity(evidence.current_tool_snapshot, liveTools);
  const contradictions: string[] = [];
  if (evidence.current_registry === "missing_after_rediscovery" && evidence.current_handshake !== "not_attempted") {
    contradictions.push("current registry cannot be missing after rediscovery while a current MCP handshake result is present");
  }
  if (evidence.fresh_registry === "missing_after_rediscovery" && evidence.fresh_handshake !== "not_attempted") {
    contradictions.push("fresh registry cannot be missing after rediscovery while a fresh-context MCP handshake result is present");
  }
  if (evidence.current_handshake === "ok" && evidence.independent_backend_health === "unhealthy") {
    contradictions.push("current-context handshake succeeded while backend health is marked unhealthy");
  }
  if (evidence.fresh_handshake === "ok" && evidence.independent_backend_health === "unhealthy") {
    contradictions.push("fresh-context handshake succeeded while backend health is marked unhealthy");
  }
  if (contradictions.length > 0) {
    return {
      classification: "inconclusive" as const,
      restart_local_runtime: false,
      next_step: "Reconcile contradictory observations before taking recovery action.",
      reasons: contradictions
    };
  }

  if (evidence.current_handshake === "ok") {
    if (integrity === "mismatch") {
      return {
        classification: "capability_registry_mismatch" as const,
        registry_integrity: integrity,
        restart_local_runtime: false,
        replay_mutation: false,
        next_step: "Compare approved app metadata with the live tool manifest; use supported metadata refresh/rebind only after reconciling existing jobs. Do not restart services or replay mutations.",
        reasons: ["The caller reports a complete tool-name inventory that differs from this same backend instance.", "This does not identify a cache, publication, permission, router or session-lifecycle cause."]
      };
    }
    if (evidence.current_tool_snapshot && integrity !== "matched_names") {
      return {
        classification: "inconclusive" as const,
        registry_integrity: integrity,
        restart_local_runtime: false,
        replay_mutation: false,
        next_step: "Collect a complete tool inventory bound to the current backend instance; reconcile inconsistent observations before recovery.",
        reasons: ["The supplied tool inventory cannot safely be compared with this live attachment."]
      };
    }
    return {
      classification: "healthy" as const,
      registry_integrity: integrity,
      restart_local_runtime: false,
      replay_mutation: false,
      next_step: "Use only verified capabilities; reconcile existing job identity before any further mutation.",
      reasons: ["The current context completed the attachment handshake.", integrity === "matched_names" ? "Tool names match; schemas, permissions and platform metadata freshness remain unverified." : "Tool registry integrity was not observed; handshake health is not a complete-capability claim."]
    };
  }

  if (
    evidence.current_registry === "missing_after_rediscovery"
    && evidence.previous_success_in_current_context
    && evidence.fresh_registry === "available"
    && evidence.fresh_handshake === "ok"
    && evidence.independent_backend_health !== "unhealthy"
  ) {
    return {
      classification: "connector_binding_lost" as const,
      restart_local_runtime: false,
      next_step: "Use the recovered fresh-context/rebind surface. Preserve managed job identity and do not restart Breakglass or duplicate work.",
      reasons: [
        "The connector previously worked in the affected context.",
        "Direct/deferred rediscovery no longer exposes it there.",
        "A fresh context reaches the backend successfully; verify backend identity separately before claiming continuity."
      ]
    };
  }

  if (
    evidence.current_registry === "available"
    && evidence.current_handshake === "session_not_found"
    && evidence.independent_backend_health !== "unhealthy"
  ) {
    return {
      classification: "mcp_session_stale" as const,
      restart_local_runtime: false,
      next_step: "Establish a new MCP session and reconcile any managed job by its existing job id before retrying work.",
      reasons: ["The connector surface is present and the backend returned the protocol-correct stale-session signal."]
    };
  }

  if (evidence.independent_backend_health === "unhealthy") {
    return {
      classification: "backend_or_transport_unavailable" as const,
      restart_local_runtime: false,
      next_step: "Escalate to independent host/AWA/tunnel diagnosis. Restart only after that layer is proven unhealthy and restart authority is explicit.",
      reasons: ["Independent backend health is unhealthy and no context has a successful handshake."]
    };
  }

  return {
    classification: "inconclusive" as const,
    restart_local_runtime: false,
    next_step: "Gather the missing registry, fresh-context and backend-health evidence; do not restart or duplicate work from an ambiguous state.",
    reasons: ["Available evidence is insufficient for a fail-safe classification."]
  };
}

export function buildHostConnectionSnapshot(input: {
  config: HostBreakglassConfig;
  processes: HostProcessManager;
  connection: HostConnectionState;
  tool_count: number;
  tool_manifest?: ToolNameManifest;
  incident?: ConnectorIncidentEvidence;
}) {
  const managedProcesses = input.processes.summary();
  if (input.tool_manifest && input.tool_manifest.tool_count !== input.tool_count) {
    throw new Error("Backend tool count disagrees with its tool-name manifest");
  }
  const liveTools = input.tool_manifest ? { ...input.tool_manifest, instance_id: input.connection.instance_id } : undefined;
  const incidentAnalysis = input.incident ? classifyConnectorIncident(input.incident, liveTools) : null;
  return {
    schema: "zerebralis.host-breakglass.connection-snapshot.v1",
    scope: "host-breakglass-backend-only",
    observed_at: new Date().toISOString(),
    backend: {
      state: "reachable",
      instance_id: input.connection.instance_id,
      started_at: input.connection.started_at,
      pid: process.pid,
      mode: input.config.mode,
      full_host_access: input.config.full_host_access,
      tool_count: input.tool_count,
      tool_manifest: input.tool_manifest ?? null,
      computer_use: input.config.computer_use.enabled
    },
    mcp_sessions: input.connection.session_snapshot?.() ?? null,
    managed_processes: managedProcesses,
    chat_binding: {
      observable: false,
      state: "not_observable_from_backend",
      note: "A healthy backend snapshot cannot prove that this connector is still registered in a particular ChatGPT session."
    },
    incident_analysis: incidentAnalysis ? { ...incidentAnalysis, evidence_source: "caller_supplied_incident_observations" as const } : null
  };
}
