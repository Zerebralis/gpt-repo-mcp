import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { HostBreakglassConfig } from "./config.js";

export class ComputerUseAdapter {
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(private readonly config: HostBreakglassConfig["computer_use"]) {}

  status() {
    return {
      enabled: this.config.enabled,
      server_url: this.config.server_url,
      allowed_tools: this.config.allowed_tools
    };
  }

  async catalog() {
    const client = await this.getClient();
    const listed = await client.listTools();
    const allowed = new Set(this.config.allowed_tools);
    return {
      ...this.status(),
      tools: listed.tools
        .filter((tool) => allowed.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations
        }))
    };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.config.enabled) throw new Error("Computer-Use adapter is disabled by host-breakglass policy.");
    if (!this.config.allowed_tools.includes(tool)) throw new Error(`Computer-Use tool is not approved: ${tool}`);
    try {
      return await (await this.getClient()).callTool({ name: tool, arguments: args }) as CallToolResult;
    } catch (error) {
      await this.reset();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async getClient(): Promise<Client> {
    if (!this.config.enabled) throw new Error("Computer-Use adapter is disabled by host-breakglass policy.");
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const client = new Client(
      { name: "gpt-repo-host-breakglass-computer-use", version: "0.1.0" },
      { capabilities: {} }
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(this.config.server_url)));
      this.client = client;
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async reset(): Promise<void> {
    const current = this.client;
    this.client = undefined;
    if (current) await current.close().catch(() => undefined);
  }
}