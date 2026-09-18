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
  it("advertises deferred discovery before asking the operator to reattach", async () => {
    const { client } = await fixture();
    const instructions = client.getInstructions();

    expect(instructions).toContain("generic/deferred tool discovery");
    expect(instructions).toContain("host_list_roots followed by host_system_info");
    expect(instructions).toContain("Do not infer reinstall, permission failure, or backend failure");
    expect(instructions).toContain("Do not silently substitute RDC, AWA, CoS");
  });

  it("exposes the canonical read-only attachment handshake", async () => {
    const { client } = await fixture();
    const listed = await client.listTools();
    const roots = listed.tools.find((tool) => tool.name === "host_list_roots");

    expect(roots?.description).toContain("Canonical read-only attachment handshake");
    expect(roots?.description).toContain("successful call proves Host Breakglass is reachable");
    expect(listed.tools.some((tool) => tool.name === "host_system_info")).toBe(true);
  });
});
