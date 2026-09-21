import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { HostPathPolicy, isWithin } from "../src/host-breakglass/path-policy.js";
import { assertProcessStartAllowed, assertShellCommandAllowed, minimalHostEnv, safeBlockLabels, safeBlockMatches } from "../src/host-breakglass/shell-policy.js";

function config(root: string, mode: "safe" | "full" = "safe") {
  return HostBreakglassConfigSchema.parse({
    enabled: true,
    mode,
    roots: [{ id: "test", root, read: true, write: true, execute: true }]
  });
}

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("host breakglass policy", () => {
  it("requires full mode before full_host_access", () => {
    expect(() => HostBreakglassConfigSchema.parse({ enabled: true, mode: "safe", full_host_access: true })).toThrow();
  });

  it("allows paths inside approved roots and rejects paths outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "gpt-host-root-"));
    const outside = await mkdtemp(join(tmpdir(), "gpt-host-outside-"));
    try {
      const file = join(root, "file.txt");
      await writeFile(file, "ok", "utf8");
      const policy = new HostPathPolicy(config(root));
      await expect(policy.resolve(file, "read")).resolves.toMatchObject({ path: file });
      await expect(policy.resolve(join(outside, "x.txt"), "read")).rejects.toThrow(/outside approved read roots/i);
      expect(isWithin(root, file)).toBe(true);
      expect(isWithin(root, outside)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("blocks guarded safe-mode commands and requires explicit full approval", () => {
    const root = tmpdir();
    const guarded = ["power", "shell -Enc", "odedCommand AAAA"].join("");
    expect(safeBlockLabels(guarded).length).toBeGreaterThan(0);
    expect(() => assertShellCommandAllowed(config(root), guarded)).toThrow(/blocked/i);
    const full = HostBreakglassConfigSchema.parse({ enabled: true, mode: "full", full_host_access: true, roots: [] });
    expect(() => assertShellCommandAllowed(full, guarded, "HOST_BREAKGLASS_FULL")).not.toThrow();
  });

  it("distinguishes real disk/boot tools from harmless PowerShell formatters", () => {
    const root = tmpdir();
    const harmless = [
      "Get-Process | Format-Table -AutoSize",
      "Get-Service; Format-List Name,Status",
      "Get-ChildItem | Format-Wide Name",
      "Write-Output 'literal; format.exe C:'",
      'Write-Output "literal | bcdedit /enum"',
      'cmd.exe /cecho harmless',
      'cmd.exe /c wh"oa"mi.exe',
      'cmd.exe /c formatter/?',
      'cmd.exe /c "formatter.exe " /?',
      'cmd.exe /c "e%BGR1_OR%cho harmless"',
      "Write-Output 'Start-Process diskpart'",
      "Get-Command Start-Process",
      "Write-Output '& ($dynamic)'"
    ];
    for (const command of harmless) {
      expect(safeBlockLabels(command), command).not.toContain("disk/boot tooling");
      expect(() => assertShellCommandAllowed(config(root), command), command).not.toThrow();
    }

    const nativeDiskTool = ["for", "mat"].join("");
    const bootConfigTool = ["bcd", "edit"].join("");
    const dangerous = [
      "cmd.exe /x/c" + nativeDiskTool + " /?",
      "cmd.exe /y /c \"" + nativeDiskTool + " /?\"",
      "cmd.exe /t:1f/c" + nativeDiskTool + " /?",
      "cmd.exe /c \"" + nativeDiskTool + ".exe\" C:",
      "cmd.exe /c \"C:\\Windows\\System32\\" + bootConfigTool + ".exe\" /enum",
      "format C:",
      "FORMAT.EXE C:",
      "diskpart",
      "Write-Output harmless\nformat C:",
      "Get-Date; bCdEdIt /enum",
      "Get-Date | C:\\Windows\\System32\\bootrec.exe /?",
      "Get-Date & 'C:\\Windows\\System32\\reagentc.exe' /info",
      'cmd.exe /c "C:\\Windows\\System32\\bcdedit.exe /enum"',
      'cmd.exe /cformat /?',
      'cmd.exe "/c" format C:',
      'cmd.exe `/c format C:',
      'cmd.exe "/d" "/s" "/c" bcdedit /enum',
      'cmd.exe /c format/?',
      'cmd.exe /c format,C:',
      'cmd.exe /c diskpart=',
      'cmd.exe /c,format C:',
      'cmd.exe /c=diskpart',
      'cmd.exe /c "format;C:" foo',
      'cmd.exe /c "(format C:)"',
      'cmd.exe /c format.exe/?',
      'cmd.exe /c C:\\Windows\\System32\\format.exe/?',
      'cmd.exe /c "format.exe " /?',
      'cmd.exe /c "format "^ /y C:',
      'cmd.exe /c cmd.exe /c format/?',
      'cmd.exe /d/cformat /?',
      'cmd.exe /d/s/c "bcdedit /enum"',
      'cmd.exe /d /s /c "bcdedit /enum"',
      'cmd.exe /c f"o"rmat /?',
      'cmd.exe /c C:\\Win"dows"\\System32\\format.exe /?',
      'cmd.exe /c "format /?',
      '. format.com /?',
      '& "fo$($null)rmat" /?',
      'cmd.exe /c "f%BGR1_OR%mat /?"',
      '& "C:\\Windows\\System32\\diskpart.exe" /s disk.txt'
    ];
    for (const command of dangerous) {
      expect(safeBlockLabels(command), command).toContain("disk/boot tooling");
      expect(() => assertShellCommandAllowed(config(root), command), command).toThrow(/disk\/boot tooling/i);
    }

    const diagnostic = safeBlockMatches("Get-Date; C:\\Windows\\System32\\BCDEDIT.EXE /enum")[0];
    expect(diagnostic).toMatchObject({
      label: "disk/boot tooling",
      token: "BCDEDIT.EXE"
    });
    expect(diagnostic?.span?.end).toBeGreaterThan(diagnostic?.span?.start ?? -1);
    expect(() => assertShellCommandAllowed(config(root), "Get-Date; C:\\Windows\\System32\\BCDEDIT.EXE /enum"))
      .toThrow(/rule="disk\/boot tooling".*token="BCDEDIT\.EXE".*span=/i);
  });

  it("fails closed on shell command indirection that can escape static command parsing", () => {
    const root = tmpdir();
    const indirect = [
      "Start-Process diskpart",
      "Invoke-Command -ScriptBlock { diskpart }",
      'Invoke-Expression "diskpart"',
      'powershell.exe -Command "diskpart"',
      'cmd.exe "" /c "diskpart"',
      '$env:FOO="/c"; cmd.exe $env:FOO diskpart',
      'Set-Alias foo diskpart; foo',
      '& ("disk" + "part")',
      '. ($dynamicCommand)'
    ];
    for (const command of indirect) {
      expect(safeBlockLabels(command), command).toContain("command indirection");
      expect(() => assertShellCommandAllowed(config(root), command), command).toThrow(/(?:command indirection|disk\/boot tooling)/i);
    }
  });

  windowsIt("walks nested PowerShell AST command nodes and blocks the reviewed escape classes", () => {
    const root = tmpdir();
    const nested = [
      "if ($true) { diskpart }",
      "foreach ($i in 1) { diskpart }",
      "while ($true) { diskpart; break }",
      "Measure-Command { diskpart }",
      "Start-Job { diskpart }",
      "1 | ForEach-Object { diskpart }",
      "wmic process call create diskpart"
    ];
    for (const command of nested) {
      expect(safeBlockLabels(command).length, command).toBeGreaterThan(0);
      expect(() => assertShellCommandAllowed(config(root), command), command).toThrow(/blocked/i);
    }

    expect(() => assertShellCommandAllowed(config(root), "if ($true) { Write-Output ok }"))
      .not.toThrow();
    expect(() => assertShellCommandAllowed(config(root), "Measure-Command { Write-Output ok }"))
      .not.toThrow();
  });

  it("checks structured process starts without blocking safe interpreter payloads", () => {
    const root = tmpdir();
    expect(() => assertProcessStartAllowed(config(root), process.execPath, ["-e", "setTimeout(()=>{},1000)"])).not.toThrow();
    expect(() => assertProcessStartAllowed(config(root), "powershell.exe", ["-NoProfile", "-Command", "Write-Output ok"])).not.toThrow();
    expect(() => assertProcessStartAllowed(config(root), "cmd.exe", ["/c", "echo", "ok"])).not.toThrow();

    expect(() => assertProcessStartAllowed(config(root), "powershell.exe", ["-NoProfile", "-Command", 'Invoke-Expression "diskpart"']))
      .toThrow(/command indirection/i);
    expect(() => assertProcessStartAllowed(config(root), "powershell.exe", ["-EncodedCommand", "AAAA"]))
      .toThrow(/encoded PowerShell/i);
    expect(() => assertProcessStartAllowed(config(root), "powershell.exe", ["-File", "script.ps1"]))
      .toThrow(/command indirection/i);
    expect(() => assertProcessStartAllowed(config(root), "cmd.exe", ["", "/c", "diskpart"]))
      .toThrow(/command indirection/i);
    expect(() => assertProcessStartAllowed(config(root), "diskpart.exe", [])).toThrow(/disk\/boot tooling/i);
  });

  it("requires the Computer-Use adapter to stay on loopback", () => {
    expect(() => HostBreakglassConfigSchema.parse({
      enabled: true,
      roots: [{ id: "test", root: tmpdir(), read: true, write: true, execute: true }],
      computer_use: { enabled: true, server_url: "https://desktop.example/mcp" }
    })).toThrow(/loopback/i);
    expect(HostBreakglassConfigSchema.parse({
      enabled: true,
      roots: [{ id: "test", root: tmpdir(), read: true, write: true, execute: true }],
      computer_use: { enabled: true, server_url: "http://127.0.0.1:3107/mcp" }
    }).computer_use.enabled).toBe(true);
  });

  it("validates credentialed HTTP bindings fail-closed", () => {
    const root = tmpdir();
    const base = {
      enabled: true,
      roots: [{ id: "test", root, read: true, write: true, execute: true }]
    };

    const valid = HostBreakglassConfigSchema.parse({
      ...base,
      http: {
        credentials: [{
          id: "groq",
          source: "windows_user_env",
          name: "GROQ_API_KEY",
          scheme: "bearer",
          allowed_hosts: ["api.groq.com"]
        }]
      }
    });
    expect(valid.http.credentials).toHaveLength(1);
    expect(valid.http.credentials[0]?.allowed_hosts).toEqual(["api.groq.com"]);

    expect(() => HostBreakglassConfigSchema.parse({
      ...base,
      http: {
        credentials: [
          { id: "same", name: "FIRST_KEY", allowed_hosts: ["api.example.com"] },
          { id: "same", name: "SECOND_KEY", allowed_hosts: ["api.example.com"] }
        ]
      }
    })).toThrow(/duplicate http credential id/i);

    expect(() => HostBreakglassConfigSchema.parse({
      ...base,
      http: {
        credentials: [{ id: "bad-host", name: "KEY", allowed_hosts: ["*.example.com"] }]
      }
    })).toThrow();

    expect(() => HostBreakglassConfigSchema.parse({
      ...base,
      http: {
        credentials: [{ id: "no-host", name: "KEY", allowed_hosts: [] }]
      }
    })).toThrow();

    expect(() => HostBreakglassConfigSchema.parse({
      ...base,
      http: {
        credentials: [{ id: "bad-source", source: "process_env", name: "KEY", allowed_hosts: ["api.example.com"] }]
      }
    })).toThrow();
  });

  it("uses a minimal inherited environment", () => {
    const env = minimalHostEnv({ BREAKGLASS_TEST: "yes" });
    expect(env.BREAKGLASS_TEST).toBe("yes");
    expect(Object.keys(env).length).toBeLessThan(30);
  });
});
