import { describe, expect, it } from "vitest";
import { buildHostShellInvocation } from "../src/host-breakglass/tools.js";
import { minimalHostEnv } from "../src/host-breakglass/shell-policy.js";
import { runProcessWithTail } from "../src/services/process-exec.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

async function runHostShell(command: string, timeout_ms = 2_000) {
  const shell = buildHostShellInvocation(command);
  return runProcessWithTail({
    executable: shell.executable,
    args: shell.args,
    cwd: process.cwd(),
    env: minimalHostEnv(),
    timeout_ms,
    tail_bytes: 4_096
  });
}

describe("host_shell Windows exit-code propagation", () => {
  for (const code of [0, 2, 7]) {
    windowsIt(`preserves native exit code ${code}`, async () => {
      const result = await runHostShell(`node -e "process.exit(${code})"`);

      expect(result.timed_out).toBe(false);
      expect(result.exit_code).toBe(code);
    });
  }

  windowsIt("preserves stderr together with the native nonzero exit code", async () => {
    const result = await runHostShell("node -e \"process.stderr.write('expected-stderr'); process.exit(7)\"");

    expect(result.timed_out).toBe(false);
    expect(result.exit_code).toBe(7);
    expect(result.stderr_tail).toContain("expected-stderr");
  });

  windowsIt("keeps timeout handling distinct from command exit codes", async () => {
    const result = await runHostShell("Start-Sleep -Seconds 5", 100);

    expect(result.timed_out).toBe(true);
  });
});
