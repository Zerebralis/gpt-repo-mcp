import { win32 } from "node:path";
import type { HostBreakglassConfig } from "./config.js";

type SafeBlockMatch = {
  label: string;
  token?: string;
  span?: { start: number; end: number };
};

const DISK_BOOT_TOOLS = new Set(["diskpart", "format", "bcdedit", "bootrec", "reagentc"]);
const SHELL_COMMAND_INDIRECTORS = new Set([
  "start-process", "saps",
  "invoke-expression", "iex",
  "invoke-command", "icm",
  "set-alias", "sal",
  "new-alias", "nal",
  "powershell", "pwsh",
  "function", "filter"
]);

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
  approval?: string,
  surface: "shell" | "process" = "shell"
): void {
  if (command.trim().length === 0) throw new Error("Command must not be empty.");
  const blocked = safeBlockMatches(command, surface)[0];
  assertPolicyMatchAllowed(config, approval, blocked);
}

export function assertProcessStartAllowed(
  config: HostBreakglassConfig,
  executable: string,
  args: string[],
  approval?: string
): void {
  const direct = findDiskBootCommand(executable, 0);
  if (direct) {
    assertPolicyMatchAllowed(config, approval, direct);
    return;
  }

  const normalized = normalizeCommandToken(executable);
  if (normalized === "cmd") {
    const parsed = processCmdPayload(args);
    if (parsed.kind === "help") return;
    if (parsed.kind === "command") {
      assertShellCommandAllowed(config, parsed.command, approval, "shell");
      return;
    }
    assertPolicyMatchAllowed(config, approval, {
      label: "command indirection",
      token: safeTokenLabel(executable)
    });
    return;
  }

  if (normalized === "powershell" || normalized === "pwsh") {
    const parsed = processPowerShellPayload(args);
    if (parsed.kind === "command") {
      assertShellCommandAllowed(config, parsed.command, approval, "shell");
      return;
    }
    assertPolicyMatchAllowed(config, approval, {
      label: parsed.kind === "encoded" ? "encoded PowerShell" : "command indirection",
      token: safeTokenLabel(executable)
    });
    return;
  }

  const joined = [executable, ...args].join(" ");
  assertShellCommandAllowed(config, joined, approval, "process");
}

function assertPolicyMatchAllowed(
  config: HostBreakglassConfig,
  approval: string | undefined,
  blocked: SafeBlockMatch | undefined
): void {
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
  return safeBlockMatches(command, "shell").map((entry) => entry.label);
}

export function safeBlockMatches(command: string, surface: "shell" | "process" = "shell"): SafeBlockMatch[] {
  const matches: SafeBlockMatch[] = [];
  const diskBoot = findDiskBootCommand(command, 0);
  if (diskBoot) matches.push(diskBoot);
  if (surface === "shell") {
    const indirection = findShellCommandIndirection(command, 0);
    if (indirection) matches.push(indirection);
  }

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

function findShellCommandIndirection(command: string, baseOffset: number, depth = 0): SafeBlockMatch | undefined {
  for (const segment of splitCommandSegments(command)) {
    const token = readLeadingToken(segment.text);
    if (!token) continue;
    const normalized = normalizeCommandToken(token.value);
    if (SHELL_COMMAND_INDIRECTORS.has(normalized)) {
      return {
        label: "command indirection",
        token: safeTokenLabel(token.value),
        span: {
          start: baseOffset + segment.start + token.start,
          end: baseOffset + segment.start + token.end
        }
      };
    }

    if (depth < 4 && normalized === "cmd") {
      const nested = cmdPayload(segment.text, token.end);
      if (nested) {
        const nestedMatch = findShellCommandIndirection(
          nested.text,
          baseOffset + segment.start + nested.start,
          depth + 1
        );
        if (nestedMatch) return nestedMatch;
      } else if (hasOpaqueCmdArguments(segment.text, token.end)) {
        return {
          label: "command indirection",
          token: safeTokenLabel(token.value),
          span: {
            start: baseOffset + segment.start + token.start,
            end: baseOffset + segment.start + token.end
          }
        };
      }
    }
  }

  return findDynamicInvocationOperator(command, baseOffset);
}

function hasOpaqueCmdArguments(text: string, afterCommand: number): boolean {
  const remainder = text.slice(afterCommand).trim();
  if (remainder.length === 0) return false;
  return !/^\/\?\s*$/i.test(remainder);
}

function findDynamicInvocationOperator(command: string, baseOffset: number): SafeBlockMatch | undefined {
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

    if (char === "&") {
      let next = index + 1;
      while (next < command.length && /\s/.test(command[next])) next += 1;
      if (next < command.length && "$({[".includes(command[next])) {
        return {
          label: "command indirection",
          token: "<dynamic-invocation>",
          span: { start: baseOffset + index, end: baseOffset + next + 1 }
        };
      }
    }

    if (char === ".") {
      let previous = index - 1;
      while (previous >= 0 && /[ \t]/.test(command[previous])) previous -= 1;
      const atCommandBoundary = previous < 0 || /[;|&\r\n]/.test(command[previous]);
      let next = index + 1;
      if (atCommandBoundary && next < command.length && /\s/.test(command[next])) {
        while (next < command.length && /\s/.test(command[next])) next += 1;
        if (next < command.length && "$({[".includes(command[next])) {
          return {
            label: "command indirection",
            token: "<dynamic-dot-source>",
            span: { start: baseOffset + index, end: baseOffset + next + 1 }
          };
        }
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
    if (char === ";" || char === "|" || char === "&" || char === "\r" || char === "\n") {
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

function processCmdPayload(args: string[]):
  | { kind: "command"; command: string }
  | { kind: "help" }
  | { kind: "opaque" } {
  if (args.length === 1 && args[0].trim() === "/?") return { kind: "help" };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.length === 0) return { kind: "opaque" };
    const parsed = parseCmdSwitchSequence(value);
    if (!parsed) return { kind: "opaque" };
    if (!parsed.command) continue;

    const parts: string[] = [];
    if (parsed.payloadSuffix.length > 0) parts.push(parsed.payloadSuffix);
    parts.push(...args.slice(index + 1));
    const command = parts.join(" ").trim();
    return command.length > 0 ? { kind: "command", command } : { kind: "opaque" };
  }
  return { kind: "opaque" };
}

function processPowerShellPayload(args: string[]):
  | { kind: "command"; command: string }
  | { kind: "encoded" }
  | { kind: "file" }
  | { kind: "opaque" } {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].trim().toLowerCase();
    if (value === "-encodedcommand" || value === "-enc") return { kind: "encoded" };
    if (value === "-file" || value === "-f") return { kind: "file" };
    if (value === "-command" || value === "-c" || value === "-commandwithargs") {
      const command = args.slice(index + 1).join(" ").trim();
      return command.length > 0 ? { kind: "command", command } : { kind: "opaque" };
    }
  }
  return { kind: "opaque" };
}

function cmdPayload(text: string, afterCommand: number): { text: string; start: number } | undefined {
  let index = afterCommand;

  while (index < text.length) {
    const relative = readLeadingToken(text.slice(index));
    if (!relative) return undefined;
    const token = {
      value: relative.value,
      start: index + relative.start,
      end: index + relative.end
    };
    const parsed = parseCmdSwitchSequence(token.value);
    if (!parsed) return undefined;

    if (parsed.command) {
      if (parsed.payloadSuffix.length > 0) {
        const raw = parsed.payloadSuffix + text.slice(token.end);
        return raw.length > 0 ? { text: raw, start: token.start } : undefined;
      }

      index = token.end;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      if (index >= text.length) return undefined;
      return normalizeCmdPayload(text.slice(index), index);
    }

    index = token.end;
  }
  return undefined;
}

function parseCmdSwitchSequence(value: string): { command: boolean; payloadSuffix: string } | undefined {
  let cursor = 0;
  let sawOption = false;

  while (cursor < value.length) {
    while (cursor < value.length && /[,;=]/.test(value[cursor])) cursor += 1;
    if (cursor >= value.length) return sawOption ? { command: false, payloadSuffix: "" } : undefined;

    const tail = value.slice(cursor);
    const command = /^\/[ck]/i.exec(tail);
    if (command) {
      return { command: true, payloadSuffix: tail.slice(command[0].length) };
    }

    const option = /^\/(?:d|s|q|a|u|x|y|e:(?:on|off)|f:(?:on|off)|v:(?:on|off)|t:[a-f0-9]{1,2})(?=\/|[,;=]|$)/i.exec(tail);
    if (!option) return undefined;
    sawOption = true;
    cursor += option[0].length;
  }

  return sawOption ? { command: false, payloadSuffix: "" } : undefined;
}

function normalizeCmdPayload(raw: string, start: number): { text: string; start: number } | undefined {
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
