import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HostBreakglassContext } from "./context.js";
import { registerHostBreakglassTools } from "./tools.js";
import { AGENT_ORCHESTRATION_INSTRUCTIONS } from "../orchestration/instructions.js";

export function createHostBreakglassMcpServer(context: HostBreakglassContext): McpServer {
  const server = new McpServer(
    { name: "gpt-repo-host-breakglass", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        AGENT_ORCHESTRATION_INSTRUCTIONS,
        "Independent host breakglass control plane for operator-approved recovery work.",
        "Use absolute paths and stay within configured roots unless full_host_access is deliberately enabled.",
        "Prefer bounded file/Git/process tools over host_shell when they can perform the task.",
        "A failed repo/build/test/review process is a diagnosis boundary, not permission to switch to Explorer or Computer Use. Do not use GUI/Desktop actions as a fallback unless the operator explicitly requested GUI interaction or the task intrinsically requires GUI.",
        "If host_process_start reports a stale or missing working directory, refresh the repository/worktree path before retrying; do not diagnose the executable or Breakglass itself as unavailable.",
        "If direct host_* tools are not visible in the current chat but generic/deferred tool discovery is available, search for Host Breakglass tools there before concluding that Breakglass is unavailable.",
        "A successful host_list_roots followed by host_system_info is the canonical read-only attachment handshake for the current chat.",
        "Use host_connection_snapshot for backend-only instance/session/job evidence; it explicitly cannot prove whether this connector remains registered in a particular ChatGPT session.",
        "Classify connector_binding_lost only when the connector previously worked in the affected chat, direct/deferred rediscovery no longer exposes it there, and a fresh context/rebind successfully reaches Breakglass. Do not restart the local runtime for that state.",
        "If a fresh context also cannot reach Breakglass, escalate to independent AWA/host/tunnel diagnosis before any restart. Preserve existing managed job ids and reconcile them before starting replacement work.",
        "Do not infer reinstall, permission failure, or backend failure solely from a missing direct tool surface. Only ask the operator to reattach/select Host Breakglass after both direct and generic/deferred discovery fail.",
        "Do not silently substitute RDC, AWA, CoS, or another host-control path when Host Breakglass was requested.",
        "Safe mode blocks selected high-risk host commands. Full mode still requires explicit HOST_BREAKGLASS_FULL approval for guarded actions.",
        "This server is intentionally separate from the normal gpt-repo-mcp product and must not be treated as a repo-policy bypass."
      ].join(" ")
    }
  );
  registerHostBreakglassTools(server, context);
  return server;
}
