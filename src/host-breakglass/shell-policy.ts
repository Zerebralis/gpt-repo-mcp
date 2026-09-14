import type { HostBreakglassConfig } from "./config.js";

const SAFE_BLOCK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "disk/boot tooling", pattern: /(^|[;&|]\s*)(diskpart|format|bcdedit|bootrec|reagentc)(?:\.exe)?\b/i },
  { label: "host shutdown/restart", pattern: /\b(shutdown(?:\.exe)?|restart-computer|stop-computer)\b/i },
  { label: "account administration", pattern: /\b(net\s+(user|localgroup)|new-localuser|remove-localuser|add-localgroupmember)\b/i },
  { label: "encoded PowerShell", pattern: /\bpowershell(?:\.exe)?\b[^\r\n]*(?:-enc|-encodedcommand)\b/i },
  { label: "drive-root recursive deletion", pattern: /\b(remove-item|del|erase|rd|rmdir)\b[^\r\n]*(?:[A-Za-z]:\\(?:\s|["']|$))/i },
  { label: "unix root recursive deletion", pattern: /\brm\b[^\r\n]*-r[^\r\n]*-f[^\r\n]*(?:\s\/\s*$|\s\/$)/i },
  { label: "firewall disable", pattern: /\b(set-netfirewallprofile|netsh)\b[^\r\n]*(?:disable|off|state\s+off)/i },
  { label: "credential dumping", pattern: /\b(mimikatz|procdump)\b[^\r\n]*(?:lsass|sam|security)/i }
];

export function assertShellCommandAllowed(
  config: HostBreakglassConfig,
  command: string,
  approval?: string
): void {
  if (command.trim().length === 0) throw new Error("Command must not be empty.");
  const blocked = SAFE_BLOCK_PATTERNS.find((entry) => entry.pattern.test(command));
  if (!blocked) return;
  if (config.mode === "full" && approval === "HOST_BREAKGLASS_FULL") return;
  throw new Error(`Command blocked by host-breakglass safe policy (${blocked.label}). Full mode plus explicit HOST_BREAKGLASS_FULL approval is required.`);
}

export function minimalHostEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const names = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC",
    "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "NUMBER_OF_PROCESSORS"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

export function safeBlockLabels(command: string): string[] {
  return SAFE_BLOCK_PATTERNS.filter((entry) => entry.pattern.test(command)).map((entry) => entry.label);
}
