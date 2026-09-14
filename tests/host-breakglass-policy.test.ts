import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { HostPathPolicy, isWithin } from "../src/host-breakglass/path-policy.js";
import { assertShellCommandAllowed, minimalHostEnv, safeBlockLabels } from "../src/host-breakglass/shell-policy.js";

function config(root: string, mode: "safe" | "full" = "safe") {
  return HostBreakglassConfigSchema.parse({
    enabled: true,
    mode,
    roots: [{ id: "test", root, read: true, write: true, execute: true }]
  });
}

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

  it("uses a minimal inherited environment", () => {
    const env = minimalHostEnv({ BREAKGLASS_TEST: "yes" });
    expect(env.BREAKGLASS_TEST).toBe("yes");
    expect(Object.keys(env).length).toBeLessThan(30);
  });
});
