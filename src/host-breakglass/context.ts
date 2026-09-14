import type { HostBreakglassConfig } from "./config.js";
import { HostAuditLog } from "./audit.js";
import { HostPathPolicy } from "./path-policy.js";
import { HostProcessManager } from "./process-manager.js";

export type HostBreakglassContext = {
  config: HostBreakglassConfig;
  paths: HostPathPolicy;
  audit: HostAuditLog;
  processes: HostProcessManager;
};

export function createHostBreakglassContext(config: HostBreakglassConfig): HostBreakglassContext {
  return {
    config,
    paths: new HostPathPolicy(config),
    audit: new HostAuditLog(config.audit_path),
    processes: new HostProcessManager(config.limits.max_processes, config.limits.max_output_bytes)
  };
}
