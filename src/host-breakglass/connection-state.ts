import { randomUUID } from "node:crypto";
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

export type ConnectorIncidentEvidence = {
  previous_success_in_current_context: boolean;
  current_registry: "available" | "missing_after_rediscovery" | "unknown";
  current_handshake: "ok" | "session_not_found" | "transport_error" | "not_attempted";
  fresh_registry: "available" | "missing_after_rediscovery" | "unknown";
  fresh_handshake: "ok" | "session_not_found" | "transport_error" | "not_attempted";
  independent_backend_health: "healthy" | "unhealthy" | "unknown";
};

export type ConnectorIncidentClassification =
  | "healthy"
  | "connector_binding_lost"
  | "mcp_session_stale"
  | "backend_or_transport_unavailable"
  | "inconclusive";

export function createHostConnectionState(): HostConnectionState {
  return {
    instance_id: randomUUID(),
    started_at: new Date().toISOString()
  };
}

export function classifyConnectorIncident(evidence: ConnectorIncidentEvidence) {
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
    return {
      classification: "healthy" as const,
      restart_local_runtime: false,
      next_step: "Continue with the existing connector session.",
      reasons: ["The current context completed the attachment handshake."]
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
        "A fresh context reaches the same backend successfully."
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
  incident?: ConnectorIncidentEvidence;
}) {
  const managedProcesses = input.processes.summary();
  const incidentAnalysis = input.incident ? classifyConnectorIncident(input.incident) : null;
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
      tool_count: input.tool_count,
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
