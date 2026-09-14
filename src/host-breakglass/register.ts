import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HostBreakglassContext } from "./context.js";
import { registerHostBreakglassTools } from "./tools.js";

export function createHostBreakglassMcpServer(context: HostBreakglassContext): McpServer {
  const server = new McpServer(
    { name: "gpt-repo-host-breakglass", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Independent host breakglass control plane for operator-approved recovery work.",
        "Use absolute paths and stay within configured roots unless full_host_access is deliberately enabled.",
        "Prefer bounded file/Git/process tools over host_shell when they can perform the task.",
        "Safe mode blocks selected high-risk host commands. Full mode still requires explicit HOST_BREAKGLASS_FULL approval for guarded actions.",
        "This server is intentionally separate from the normal gpt-repo-mcp product and must not be treated as a repo-policy bypass."
      ].join(" ")
    }
  );
  registerHostBreakglassTools(server, context);
  return server;
}
