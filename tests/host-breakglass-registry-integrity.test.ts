import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { classifyConnectorIncident, createToolNameManifest, type ConnectorIncidentEvidence } from "../src/host-breakglass/connection-state.js";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { createHostBreakglassMcpServer } from "../src/host-breakglass/register.js";

const instance = "00000000-0000-4000-8000-000000000001";
const otherInstance = "00000000-0000-4000-8000-000000000002";
const live = { instance_id: instance, tool_count: 42, tool_names_sha256: "a".repeat(64) };
const evidence: ConnectorIncidentEvidence = {
  previous_success_in_current_context: true,
  current_registry: "available", current_handshake: "ok",
  fresh_registry: "unknown", fresh_handshake: "not_attempted",
  independent_backend_health: "healthy"
};
const snapshot = { backend_instance_id: instance, inventory_complete: true, tool_count: 39, tool_names_sha256: "b".repeat(64) };

describe("BG registry integrity: handshake success is not a complete registry", () => {
  it("does not call 39 exposed names healthy against a bound 42-tool backend", () => {
    expect(classifyConnectorIncident({ ...evidence, current_tool_snapshot: snapshot }, live)).toMatchObject({
      classification: "capability_registry_mismatch", restart_local_runtime: false,
      replay_mutation: false, registry_integrity: "mismatch"
    });
  });

  it("detects wrong tool membership even when counts are equal", () => {
    expect(classifyConnectorIncident({ ...evidence, current_tool_snapshot: { ...snapshot, tool_count: 42 } }, live)).toMatchObject({
      classification: "capability_registry_mismatch", registry_integrity: "mismatch"
    });
  });

  it("does not compare observations from another backend incarnation", () => {
    expect(classifyConnectorIncident({ ...evidence, current_tool_snapshot: { ...snapshot, backend_instance_id: otherInstance } }, live)).toMatchObject({
      classification: "inconclusive", registry_integrity: "attachment_mismatch", restart_local_runtime: false
    });
  });

  it("distinguishes a matching name set from unobserved schemas and permissions", () => {
    const result = classifyConnectorIncident({ ...evidence, current_tool_snapshot: { ...snapshot, tool_count: 42, tool_names_sha256: live.tool_names_sha256 } }, live);
    expect(result).toMatchObject({ classification: "healthy", registry_integrity: "matched_names", replay_mutation: false });
    expect(result.reasons.join(" ")).toContain("schemas, permissions and platform metadata freshness remain unverified");
  });

  it("keeps legacy handshake health compatible without attesting registry integrity", () => {
    expect(classifyConnectorIncident(evidence)).toMatchObject({ classification: "healthy", registry_integrity: "not_observed" });
  });

  it("does not treat a deferred partial discovery result as a complete inventory", () => {
    expect(classifyConnectorIncident({ ...evidence, current_tool_snapshot: { ...snapshot, inventory_complete: false } }, live)).toMatchObject({
      classification: "inconclusive", registry_integrity: "unverified", replay_mutation: false
    });
  });

  it("requires an authoritative live identity rather than two caller claims", () => {
    expect(classifyConnectorIncident({ ...evidence, current_tool_snapshot: snapshot })).toMatchObject({
      classification: "inconclusive", registry_integrity: "unverified"
    });
  });

  it("rejects a matching set hash paired with a contradictory count", () => {
    expect(classifyConnectorIncident({ ...evidence, current_tool_snapshot: { ...snapshot, tool_names_sha256: live.tool_names_sha256 } }, live)).toMatchObject({
      classification: "inconclusive", registry_integrity: "contradictory"
    });
  });

  it.each([-1, 257, 1.5])("rejects invalid diagnostic count %s", (tool_count) => {
    expect(classifyConnectorIncident({ ...evidence, current_tool_snapshot: { ...snapshot, tool_count } }, live)).toMatchObject({
      classification: "inconclusive", registry_integrity: "invalid_observation"
    });
  });

  it("does not echo invalid caller strings into the diagnosis", () => {
    const value = "invalid-caller-value";
    const result = classifyConnectorIncident({ ...evidence, current_tool_snapshot: { ...snapshot, tool_names_sha256: value } }, live);
    expect(result).toMatchObject({ classification: "inconclusive", registry_integrity: "invalid_observation" });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it("preserves contradictory backend evidence as inconclusive, never a registry diagnosis", () => {
    expect(classifyConnectorIncident({ ...evidence, independent_backend_health: "unhealthy", current_tool_snapshot: snapshot }, live)).toMatchObject({
      classification: "inconclusive", restart_local_runtime: false
    });
  });

  it("has no recovery side effects and leaves caller evidence unchanged", () => {
    const input = { ...evidence, current_tool_snapshot: { ...snapshot } };
    const before = JSON.stringify(input);
    const first = classifyConnectorIncident(input, live);
    expect(classifyConnectorIncident(input, live)).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toMatchObject({ restart_local_runtime: false, replay_mutation: false });
  });
});

describe("bounded tool-name manifest", () => {
  it("is order independent, immutable and explicit about its limited scope", () => {
    const names = ["host_system_info", "host_list_roots"];
    const manifest = createToolNameManifest(names);
    expect(manifest).toEqual(createToolNameManifest([...names].reverse()));
    expect(manifest).toMatchObject({ scope: "tool_names_only", tool_count: 2 });
    expect(manifest.tool_names_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(names[0]).toBe("host_system_info");
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.tool_names)).toBe(true);
  });

  it("does not reduce integrity to tool count", () => {
    expect(createToolNameManifest(["host_stat"]).tool_names_sha256).not.toBe(createToolNameManifest(["host_search"]).tool_names_sha256);
  });

  it("rejects duplicate, malformed and unbounded names", () => {
    expect(() => createToolNameManifest(["host_stat", "host_stat"])).toThrow("Invalid Host Breakglass");
    expect(() => createToolNameManifest(["not a tool"])).toThrow("Invalid Host Breakglass");
    expect(() => createToolNameManifest(Array.from({ length: 257 }, (_, i) => `host_tool_${i}`))).toThrow("Invalid Host Breakglass");
  });
});

it("binds the old roots handshake, actual 42-tool enumeration and new diagnosis in Full mode", async () => {
  const context = createHostBreakglassContext(HostBreakglassConfigSchema.parse({
    enabled: true, mode: "full", full_host_access: true,
    roots: [{ id: "test", root: process.cwd(), read: true }]
  }));
  const server = createHostBreakglassMcpServer(context);
  const client = new Client({ name: "registry-integrity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const actual = createToolNameManifest(listed.tools.map((tool) => tool.name));
    expect(actual.tool_count).toBe(42);
    const rootsResult = await client.callTool({ name: "host_list_roots", arguments: {} });
    const content = rootsResult.content as Array<{ type: string; text?: string }>;
    const roots = JSON.parse(content.find((item) => item.type === "text")!.text!).result;
    expect(roots).toMatchObject({ mode: "full", full_host_access: true });
    expect(roots.backend_attachment.tool_manifest).toEqual(actual);
    const oldNames = actual.tool_names.filter((name) => !["host_connection_snapshot", "host_http_request", "host_review_runtime"].includes(name));
    const partial = createToolNameManifest(oldNames);
    const response = await client.callTool({ name: "host_connection_snapshot", arguments: { incident: {
      ...evidence, current_tool_snapshot: { backend_instance_id: roots.backend_attachment.instance_id,
        inventory_complete: true, tool_count: partial.tool_count, tool_names_sha256: partial.tool_names_sha256 }
    } } });
    const resultContent = response.content as Array<{ type: string; text?: string }>;
    const parsed = JSON.parse(resultContent.find((item) => item.type === "text")!.text!);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.backend.tool_manifest).toEqual(actual);
    expect(parsed.result.chat_binding.observable).toBe(false);
    expect(parsed.result.incident_analysis).toMatchObject({
      classification: "capability_registry_mismatch", restart_local_runtime: false, replay_mutation: false,
      evidence_source: "caller_supplied_incident_observations"
    });
    const tool = listed.tools.find((entry) => entry.name === "host_connection_snapshot");
    expect(tool?.inputSchema).toMatchObject({ properties: { incident: { properties: {
      current_tool_snapshot: { additionalProperties: false, properties: { tool_count: { maximum: 256 } } }
    } } } });
  } finally {
    await client.close();
    await server.close();
  }
});
