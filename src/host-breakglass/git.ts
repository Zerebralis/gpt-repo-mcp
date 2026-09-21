import { runGitBounded } from "../services/git-exec.js";
import type { HostBreakglassContext } from "./context.js";
import { minimalHostEnv } from "./shell-policy.js";

export type HostGitOperation =
  | "status"
  | "diff"
  | "log"
  | "branch"
  | "add"
  | "commit"
  | "fetch"
  | "pull"
  | "push"
  | "merge";

export async function hostGit(
  context: HostBreakglassContext,
  input: {
    cwd: string;
    operation: HostGitOperation;
    paths?: string[];
    message?: string;
    remote?: string;
    branch?: string;
    ref?: string;
    staged?: boolean;
    expected_head?: string;
  }
) {
  const mutation = ["add", "commit", "fetch", "pull", "push", "merge"].includes(input.operation);
  // Structured Git mutations need repository write authority, not generic host execution authority.
  // Shell/process tools remain separately gated by the root's execute capability.
  const resolved = await context.paths.resolve(input.cwd, mutation ? "write" : "read");
  await ensureGitWorktree(resolved.path, context.config.limits.max_output_bytes);

  if (input.expected_head) {
    const actualHead = await tryGetHead(resolved.path, context);
    if (actualHead !== input.expected_head) {
      throw new Error(`Git HEAD changed. expected=${input.expected_head} actual=${actualHead ?? "UNBORN"}`);
    }
  }

  const args = buildArgs(context, input);
  const result = await runGit(args, resolved.path, context);
  const head = await tryGetHead(resolved.path, context);

  return {
    cwd: resolved.path,
    root_id: resolved.root?.id,
    operation: input.operation,
    head,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated
  };
}

async function tryGetHead(cwd: string, context: HostBreakglassContext): Promise<string | undefined> {
  try {
    return (await runGit(["rev-parse", "--verify", "HEAD"], cwd, context)).stdout.trim();
  } catch {
    return undefined;
  }
}
function buildArgs(
  context: HostBreakglassContext,
  input: Parameters<typeof hostGit>[1]
): string[] {
  switch (input.operation) {
    case "status":
      return ["status", "--short", "--branch"];
    case "diff":
      return input.staged ? ["diff", "--cached", "--no-ext-diff"] : ["diff", "--no-ext-diff"];
    case "log":
      return ["log", "--oneline", "--decorate", "-n", "50"];
    case "branch":
      return ["branch", "--show-current"];
    case "add": {
      const paths = validateRelativePaths(input.paths);
      return ["add", "--", ...paths];
    }
    case "commit": {
      const message = input.message?.trim();
      if (!message) throw new Error("Commit message is required.");
      if (message.length > 500) throw new Error("Commit message is too long.");
      return ["commit", "-m", message];
    }
    case "fetch": {
      const remote = validateRemote(context, input.remote ?? "origin");
      return ["fetch", remote, "--prune"];
    }
    case "pull": {
      const remote = validateRemote(context, input.remote ?? "origin");
      if (input.branch) validateRef(input.branch);
      return ["pull", "--ff-only", remote, ...(input.branch ? [input.branch] : [])];
    }
    case "push": {
      if (!context.config.git.allow_push) throw new Error("Git push is disabled by host-breakglass policy.");
      const remote = validateRemote(context, input.remote ?? "origin");
      if (input.branch) validateRef(input.branch);
      return ["push", "--set-upstream", remote, ...(input.branch ? [input.branch] : [])];
    }
    case "merge": {
      if (!context.config.git.allow_merge) throw new Error("Git merge is disabled by host-breakglass policy.");
      const ref = input.ref?.trim();
      if (!ref) throw new Error("Merge ref is required.");
      validateRef(ref);
      return ["merge", "--no-edit", ref];
    }
  }
}

function validateRelativePaths(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) throw new Error("At least one path is required.");
  for (const path of paths) {
    if (!path || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe git path: ${path}`);
    }
  }
  return paths;
}

function validateRemote(context: HostBreakglassContext, remote: string): string {
  if (!context.config.git.allowed_remotes.includes(remote)) {
    throw new Error(`Git remote is not approved: ${remote}`);
  }
  return remote;
}

function validateRef(value: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.startsWith("-")) {
    throw new Error(`Unsafe git ref: ${value}`);
  }
}

async function ensureGitWorktree(cwd: string, maxOutputBytes: number): Promise<void> {
  const result = await runGitBounded({
    root: cwd,
    args: ["rev-parse", "--is-inside-work-tree"],
    max_stdout_bytes: maxOutputBytes,
    max_stderr_bytes: maxOutputBytes,
    allow_stdout_truncation: true,
    env: minimalHostEnv()
  });
  if (result.stdout.trim() !== "true") throw new Error("Path is not inside a Git worktree.");
}

function runGit(args: string[], cwd: string, context: HostBreakglassContext) {
  return runGitBounded({
    root: cwd,
    args,
    max_stdout_bytes: context.config.limits.max_output_bytes,
    max_stderr_bytes: context.config.limits.max_output_bytes,
    allow_stdout_truncation: true,
    env: minimalHostEnv()
  });
}
