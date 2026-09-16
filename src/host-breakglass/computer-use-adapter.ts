import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { HostBreakglassConfig } from "./config.js";

type Connection = {
  client: Client;
  abort: AbortController;
  ready: Promise<Connection>;
  discarded: boolean;
};

export class ComputerUseAdapter {
  private connection?: Connection;
  private closed = false;

  constructor(private readonly config: HostBreakglassConfig["computer_use"]) {}

  status() {
    return {
      enabled: this.config.enabled,
      server_url: this.config.server_url,
      allowed_tools: this.config.allowed_tools
    };
  }

  async catalog() {
    const connection = await this.getConnection();
    try {
      const listed = await connection.client.listTools();
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
    } catch (error) {
      this.discard(connection);
      throw error;
    }
  }

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.config.enabled) throw new Error("Computer-Use adapter is disabled by host-breakglass policy.");
    if (!this.config.allowed_tools.includes(tool)) throw new Error("Computer-Use tool is not approved: " + tool);
    const connection = await this.getConnection();
    try {
      // Keep the existing action timeout contract. Never replay a failed action.
      return await connection.client.callTool({ name: tool, arguments: args }) as CallToolResult;
    } catch (error) {
      this.discard(connection);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.connection) this.discard(this.connection);
  }

  private async getConnection(): Promise<Connection> {
    if (!this.config.enabled) throw new Error("Computer-Use adapter is disabled by host-breakglass policy.");
    if (this.closed) throw new Error("Computer-Use adapter is closed.");
    if (this.connection) return this.connection.ready;
    const client = new Client(
      { name: "gpt-repo-host-breakglass-computer-use", version: "0.1.0" },
      { capabilities: {} }
    );
    const connection: Connection = { client, abort: new AbortController(), discarded: false, ready: undefined! };
    this.connection = connection;
    client.onclose = () => this.discard(connection);
    client.onerror = () => this.discard(connection);
    connection.ready = this.connect(connection);
    return connection.ready;
  }

  private async connect(connection: Connection): Promise<Connection> {
    const { client, abort } = connection;
    let timer: NodeJS.Timeout | undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.config.server_url), {
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) })
    });
    try {
      // Covers the complete handshake, including notification send, not only initialize.
      await Promise.race([
        client.connect(transport, { timeout: 5000, signal: abort.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Computer-Use unavailable: connection deadline exceeded."));
            this.discard(connection);
          }, 5000);
        })
      ]);
      if (connection.discarded || this.closed || this.connection !== connection) {
        throw new Error("Computer-Use connection superseded or closed.");
      }
      return connection;
    } catch (error) {
      this.discard(connection);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private discard(connection: Connection): void {
    if (connection.discarded) return;
    connection.discarded = true;
    // A late failure from an old connection must not close a newer connection.
    if (this.connection === connection) this.connection = undefined;
    connection.abort.abort();
    void connection.client.close().catch(() => undefined);
  }
}
