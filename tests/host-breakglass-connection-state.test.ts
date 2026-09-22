import { describe, expect, it } from "vitest";
import {
  buildHostConnectionSnapshot,
  classifyConnectorIncident,
  createHostConnectionState,
  type ConnectorIncidentEvidence
} from "../src/host-breakglass/connection-state.js";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { HostProcessManager } from "../src/host-breakglass/process-manager.js";

const baseEvidence: ConnectorIncidentEvidence = {
  previous_success_in_current_context: false,
  current_registry: "unknown",
  current_handshake: "not_attempted",
  fresh_registry: "unknown",
  fresh_handshake: "not_attempted",
  independent_backend_health: "unknown"
};

describe("BG-R1d connector incident classification", () => {
  it("reports healthy only after a current-context handshake succeeds", () => {
    expect(classifyConnectorIncident({
      ...baseEvidence,
      current_registry: "available",
      current_handshake: "ok",
      independent_backend_health: "healthy"
    })).toMatchObject({
      classification: "healthy",
      restart_local_runtime: false
    });
  });

  it("classifies session-local connector binding loss only with previous success plus fresh-context recovery proof", () => {
    expect(classifyConnectorIncident({
      ...baseEvidence,
      previous_success_in_current_context: true,
      current_registry: "missing_after_rediscovery",
      fresh_registry: "available",
      fresh_handshake: "ok",
      independent_backend_health: "healthy"
    })).toMatchObject({
      classification: "connector_binding_lost",
      restart_local_runtime: false
    });
  });

  it("does not infer connector binding loss from a missing current surface alone", () => {
    expect(classifyConnectorIncident({
      ...baseEvidence,
      previous_success_in_current_context: true,
      current_registry: "missing_after_rediscovery",
      independent_backend_health: "healthy"
    })).toMatchObject({
      classification: "inconclusive",
      restart_local_runtime: false
    });
  });

  it("separates a protocol-correct retired MCP session from connector binding loss", () => {
    expect(classifyConnectorIncident({
      ...baseEvidence,
      previous_success_in_current_context: true,
      current_registry: "available",
      current_handshake: "session_not_found",
      independent_backend_health: "healthy"
    })).toMatchObject({
      classification: "mcp_session_stale",
      restart_local_runtime: false
    });
  });

  it("classifies backend or transport unavailability only with independent unhealthy backend evidence", () => {
    expect(classifyConnectorIncident({
      ...baseEvidence,
      previous_success_in_current_context: true,
      current_registry: "available",
      current_handshake: "transport_error",
      fresh_registry: "available",
      fresh_handshake: "transport_error",
      independent_backend_health: "unhealthy"
    })).toMatchObject({
      classification: "backend_or_transport_unavailable",
      restart_local_runtime: false
    });
  });

  it("fails closed on contradictory client/backend observations", () => {
    const result = classifyConnectorIncident({
      ...baseEvidence,
      previous_success_in_current_context: true,
      current_registry: "missing_after_rediscovery",
      fresh_registry: "available",
      fresh_handshake: "ok",
      independent_backend_health: "unhealthy"
    });
    expect(result.classification).toBe("inconclusive");
    expect(result.restart_local_runtime).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/backend health/i);
  });
});

describe("Host Breakglass backend connection snapshot", () => {
  it("provides stable backend identity without claiming chat-registry visibility", () => {
    const config = HostBreakglassConfigSchema.parse({
      enabled: true,
      roots: [{ id: "test", root: process.cwd(), read: true, execute: true }]
    });
    const connection = createHostConnectionState();
    connection.session_snapshot = () => ({
      active: 3,
      reservations: 0,
      in_flight: 1,
      reclaimable_under_pressure: 2,
      oldest_idle_ms: 12_000,
      cumulative: {
        committed: 9,
        normal_expired: 1,
        pressure_reclaimed: 4,
        emergency_reclaimed: 0,
        admission_rejected: 0,
        pressure_reclaim_reuse_attempts: 0,
        emergency_reclaim_reuse_attempts: 0,
        normal_expiry_reuse_attempts: 0,
        unknown_session_misses: 0
      },
      capacity: 100,
      soft_target: 80,
      pressure_high_watermark: 90,
      idle_ttl_ms: 600_000,
      pressure_idle_ttl_ms: 60_000
    });

    const processes = new HostProcessManager(4, 4096);
    const first = buildHostConnectionSnapshot({ config, processes, connection, tool_count: 42 });
    const second = buildHostConnectionSnapshot({ config, processes, connection, tool_count: 42 });

    expect(first.schema).toBe("zerebralis.host-breakglass.connection-snapshot.v1");
    expect(first.scope).toBe("host-breakglass-backend-only");
    expect(first.backend.instance_id).toBe(second.backend.instance_id);
    expect(first.backend.started_at).toBe(second.backend.started_at);
    expect(first.backend.tool_count).toBe(42);
    expect(first.mcp_sessions?.active).toBe(3);
    expect(first.chat_binding).toMatchObject({
      observable: false,
      state: "not_observable_from_backend"
    });
    expect(first.managed_processes).toEqual({
      total: 0,
      running: 0,
      terminal: 0,
      running_job_ids: []
    });
  });
});
