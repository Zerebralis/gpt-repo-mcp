import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { createHostBreakglassMcpServer } from "../src/host-breakglass/register.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function fixture() {
  const context = createHostBreakglassContext(HostBreakglassConfigSchema.parse({
    enabled: true,
    roots: [{ id: "test", root: process.cwd(), read: true, execute: true }]
  }));
  const server = createHostBreakglassMcpServer(context);
  const client = new Client({ name: "host-breakglass-register-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  closers.push(async () => {
    await client.close();
    await server.close();
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
}

describe("Host Breakglass attachment/discovery guidance", () => {
  it("advertises rediscovery, binding-loss classification and no-restart recovery", async () => {
    const { client } = await fixture();
    const instructions = client.getInstructions();

    expect(instructions).toContain("generic/deferred tool discovery");
    expect(instructions).toContain("host_list_roots followed by host_system_info");
    expect(instructions).toContain("host_connection_snapshot");
    expect(instructions).toContain("connector_binding_lost");
    expect(instructions).toContain("fresh context/rebind");
    expect(instructions).toContain("Do not restart the local runtime");
    expect(instructions).toContain("Preserve existing managed job ids");
    expect(instructions).toContain("Do not infer reinstall, permission failure, or backend failure");
    expect(instructions).toContain("Do not silently substitute RDC, AWA, CoS");
  });

  it("exposes the canonical handshake plus backend-only connection snapshot", async () => {
    const { client } = await fixture();
    const listed = await client.listTools();
    const roots = listed.tools.find((tool) => tool.name === "host_list_roots");
    const snapshotTool = listed.tools.find((tool) => tool.name === "host_connection_snapshot");

    expect(roots?.description).toContain("Canonical read-only attachment handshake");
    expect(roots?.description).toContain("successful call proves Host Breakglass is reachable");
    expect(snapshotTool?.description).toContain("backend-only");
    expect(snapshotTool?.description).toContain("cannot observe");
    expect(listed.tools.some((tool) => tool.name === "host_system_info")).toBe(true);
    expect(listed.tools.some((tool) => tool.name === "host_review_runtime")).toBe(true);
    expect(listed.tools).toHaveLength(42);

    const response = await client.callTool({
      name: "host_connection_snapshot",
      arguments: {
        incident: {
          previous_success_in_current_context: true,
          current_registry: "missing_after_rediscovery",
          current_handshake: "not_attempted",
          fresh_registry: "available",
          fresh_handshake: "ok",
          independent_backend_health: "healthy"
        }
      }
    });
    const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const text = content.find((item) => item.type === "text")?.text;
    const parsed = text ? JSON.parse(text) : undefined;
    expect(parsed?.ok).toBe(true);
    expect(parsed?.result).toMatchObject({
      schema: "zerebralis.host-breakglass.connection-snapshot.v1",
      scope: "host-breakglass-backend-only",
      chat_binding: { observable: false, state: "not_observable_from_backend" },
      incident_analysis: {
        classification: "connector_binding_lost",
        restart_local_runtime: false,
        evidence_source: "caller_supplied_incident_observations"
      }
    });
  });
});
