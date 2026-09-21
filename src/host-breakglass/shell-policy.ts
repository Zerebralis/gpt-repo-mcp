import { win32 } from "node:path";
import type { HostBreakglassConfig } from "./config.js";

type SafeBlockMatch = {
  label: string;
  token?: string;
  span?: { start: number; end: number };
};

const DISK_BOOT_TOOLS = new Set(["diskpart", "format", "bcdedit", "bootrec", "reagentc"]);

const SAFE_BLOCK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
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
  const blocked = safeBlockMatches(command)[0];
  if (!blocked) return;
  if (config.mode === "full" && approval === "HOST_BREAKGLASS_FULL") return;

  const detail = [
    'rule="' + blocked.label + '"',
    blocked.token ? 'token="' + blocked.token + '"' : undefined,
    blocked.span ? "span=" + blocked.span.start + ":" + blocked.span.end : undefined
  ].filter(Boolean).join("; ");
  throw new Error(
    "Command blocked by host-breakglass safe policy (" + detail +
    "). Full mode plus explicit HOST_BREAKGLASS_FULL approval is required."
  );
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
  return safeBlockMatches(command).map((entry) => entry.label);
}

export function safeBlockMatches(command: string): SafeBlockMatch[] {
  const matches: SafeBlockMatch[] = [];
  const diskBoot = findDiskBootCommand(command, 0);
  if (diskBoot) matches.push(diskBoot);

  for (const entry of SAFE_BLOCK_PATTERNS) {
    const match = entry.pattern.exec(command);
    if (match) matches.push({
      label: entry.label,
      span: { start: match.index, end: match.index + match[0].length }
    });
  }
  return matches;
}

function findDiskBootCommand(command: string, baseOffset: number, depth = 0): SafeBlockMatch | undefined {
  for (const segment of splitCommandSegments(command)) {
    const token = readLeadingToken(segment.text);
    if (!token) continue;

    const normalized = normalizeCommandToken(token.value);
    if (DISK_BOOT_TOOLS.has(normalized)) {
      return {
        label: "disk/boot tooling",
        token: safeTokenLabel(token.value),
        span: {
          start: baseOffset + segment.start + token.start,
          end: baseOffset + segment.start + token.end
        }
      };
    }

    if (depth === 0 && (normalized === "cmd")) {
      const nested = cmdPayload(segment.text, token.end);
      if (nested) {
        const nestedMatch = findDiskBootCommand(
          nested.text,
          baseOffset + segment.start + nested.start,
          depth + 1
        );
        if (nestedMatch) return nestedMatch;
      }
    }
  }
  return undefined;
}

function splitCommandSegments(command: string): Array<{ text: string; start: number }> {
  const segments: Array<{ text: string; start: number }> = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "`" || char === "^") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      segments.push({ text: command.slice(start, index), start });
      start = index + 1;
    }
  }
  segments.push({ text: command.slice(start), start });
  return segments;
}

function readLeadingToken(text: string): { value: string; start: number; end: number } | undefined {
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return undefined;

  const start = index;
  const quote = text[index] === "'" || text[index] === '"' ? text[index++] : undefined;
  let value = "";
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (escaped) {
      value += char;
      escaped = false;
      index += 1;
      continue;
    }
    if (char === "`" || char === "^") {
      escaped = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        index += 1;
        break;
      }
      value += char;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) break;
    value += char;
    index += 1;
  }

  return value ? { value, start, end: index } : undefined;
}

function normalizeCommandToken(token: string): string {
  return win32.basename(token).replace(/\.(?:exe|com)$/i, "").toLowerCase();
}

function safeTokenLabel(token: string): string {
  return win32.basename(token).slice(0, 120);
}

function cmdPayload(text: string, afterCommand: number): { text: string; start: number } | undefined {
  let index = afterCommand;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  const switchMatch = /^\/(?:c|k)\b/i.exec(text.slice(index));
  if (!switchMatch) return undefined;
  index += switchMatch[0].length;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return undefined;

  const raw = text.slice(index);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return { text: raw.slice(1, -1), start: index + 1 };
  }
  return { text: raw, start: index };
}
