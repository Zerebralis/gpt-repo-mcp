import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { hostGit } from "../src/host-breakglass/git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

function contextFor(root: string, write: boolean, execute: boolean) {
  return createHostBreakglassContext(HostBreakglassConfigSchema.parse({
    enabled: true,
    mode: "safe",
    roots: [{ id: "repo", root, read: true, write, execute }],
    git: { allow_push: false, allow_merge: false, allowed_remotes: ["origin"] }
  }));
}

describe("host_git root capability boundary", () => {
  it("allows bounded fetch with write authority while generic execute remains denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "gpt-host-git-write-"));
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    try {
      await git(root, ["init", "--bare", remote]);
      await git(root, ["init", repo]);
      await git(repo, ["remote", "add", "origin", remote]);

      const context = contextFor(root, true, false);

      await expect(context.paths.resolve(repo, "execute")).rejects.toThrow(/outside approved execute roots/i);
      await expect(hostGit(context, { cwd: repo, operation: "fetch", remote: "origin" }))
        .resolves.toMatchObject({ operation: "fetch", exit_code: 0, root_id: "repo" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still refuses bounded Git mutations when the root lacks write authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "gpt-host-git-nowrite-"));
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    try {
      await git(root, ["init", "--bare", remote]);
      await git(root, ["init", repo]);
      await git(repo, ["remote", "add", "origin", remote]);

      const context = contextFor(root, false, true);

      await expect(hostGit(context, { cwd: repo, operation: "fetch", remote: "origin" }))
        .rejects.toThrow(/outside approved write roots/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
