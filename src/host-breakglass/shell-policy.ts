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
    let token = readLeadingToken(segment.text);
    if (!token) continue;

    if (token.value === ".") {
      const invoked = readLeadingToken(segment.text.slice(token.end));
      if (!invoked) continue;
      token = {
        value: invoked.value,
        start: token.end + invoked.start,
        end: token.end + invoked.end
      };
    }

    const normalized = normalizeCommandToken(token.value);
    const directDiskBoot = matchDiskBootToken(token.value);
    if (directDiskBoot || dynamicCommandCouldResolveToDiskBoot(token.value)) {
      return {
        label: "disk/boot tooling",
        token: directDiskBoot?.label ?? "<dynamic-command>",
        span: {
          start: baseOffset + segment.start + token.start,
          end: baseOffset + segment.start + token.end
        }
      };
    }

    if (depth < 4 && normalized === "cmd") {
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
  let quote: "'" | '"' | undefined;
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
        quote = undefined;
        index += 1;
        continue;
      }
      value += char;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) break;
    value += char;
    index += 1;
  }

  return value ? { value, start, end: index } : undefined;
}

function matchDiskBootToken(token: string): { label: string } | undefined {
  const trimmed = token.trim();
  const normalized = normalizeCommandToken(trimmed);
  if (DISK_BOOT_TOOLS.has(normalized)) {
    return { label: safeTokenLabel(trimmed) };
  }

  for (const tool of DISK_BOOT_TOOLS) {
    const attachedSwitch = new RegExp(
      `(?:^|[\\\\/,;=(])(${tool}(?:\\.(?:exe|com))?)(?=\\s|\\/|[,;=)]|$)`,
      "i"
    ).exec(trimmed);
    if (attachedSwitch) return { label: attachedSwitch[1].slice(0, 120) };
  }
  return undefined;
}

function normalizeCommandToken(token: string): string {
  return win32.basename(token.trim()).replace(/\.(?:exe|com)$/i, "").toLowerCase();
}

function dynamicCommandCouldResolveToDiskBoot(token: string): boolean {
  const dynamicPatterns = [
    /%[^%\r\n]+%/g,
    /![^!\r\n]+!/g,
    /\$\([^)]*\)/g,
    /\$env:[A-Za-z_][A-Za-z0-9_]*/gi,
    /\$[A-Za-z_][A-Za-z0-9_]*/g
  ];
  let skeleton = token;
  let dynamic = false;
  for (const pattern of dynamicPatterns) {
    const next = skeleton.replace(pattern, () => {
      dynamic = true;
      return "";
    });
    skeleton = next;
  }
  if (!dynamic) return false;
  if (matchDiskBootToken(skeleton)) return true;

  const normalizedSkeleton = normalizeCommandToken(skeleton);
  if (normalizedSkeleton.length === 0) return true;
  return [...DISK_BOOT_TOOLS].some((tool) => isSubsequence(normalizedSkeleton, tool));
}

function isSubsequence(candidate: string, target: string): boolean {
  let index = 0;
  for (const char of target) {
    if (candidate[index] === char) index += 1;
    if (index === candidate.length) return true;
  }
  return false;
}

function safeTokenLabel(token: string): string {
  return win32.basename(token).slice(0, 120);
}

function cmdPayload(text: string, afterCommand: number): { text: string; start: number } | undefined {
  let index = afterCommand;
  while (index < text.length && /\s/.test(text[index])) index += 1;

  while (index < text.length) {
    if (text[index] !== "/") return undefined;
    const tail = text.slice(index);
    if (/^\/[ck]/i.test(tail)) {
      index += 2;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      if (index >= text.length) return undefined;

      let raw = text.slice(index);
      let start = index;
      const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : undefined;
      if (quote) {
        const closingQuote = raw.indexOf(quote, 1);
        if (raw.endsWith(quote)) {
          raw = raw.slice(1, -1);
          start += 1;
        } else if (closingQuote < 0) {
          raw = raw.slice(1);
          start += 1;
        }
      }
      return raw.length > 0 ? { text: raw, start } : undefined;
    }

    const option = /^\/(?:d|s|q|a|u|x|y|e:(?:on|off)|f:(?:on|off)|v:(?:on|off)|t:[a-f0-9]{1,2})(?=[\s/]|$)/i.exec(tail);
    if (!option) return undefined;
    index += option[0].length;
    while (index < text.length && /\s/.test(text[index])) index += 1;
  }
  return undefined;
}
