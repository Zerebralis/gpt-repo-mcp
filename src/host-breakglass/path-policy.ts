import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { HostBreakglassConfig, HostRootConfig } from "./config.js";

export type HostCapability = "read" | "write" | "execute";
export type ResolvedHostPath = { path: string; root?: HostRootConfig };

export class HostPathPolicy {
  constructor(private readonly config: HostBreakglassConfig) {}

  async resolve(inputPath: string, capability: HostCapability): Promise<ResolvedHostPath> {
    if (!isAbsolute(inputPath)) {
      throw new Error("Host paths must be absolute.");
    }
    const target = resolve(inputPath);
    if (this.config.mode === "full" && this.config.full_host_access) {
      return { path: target };
    }

    const candidates = this.config.roots
      .filter((entry) => entry[capability])
      .filter((entry) => isWithin(resolve(entry.root), target))
      .sort((a, b) => b.root.length - a.root.length);
    const root = candidates[0];
    if (!root) {
      throw new Error(`Path is outside approved ${capability} roots.`);
    }

    await assertNoSymlinkEscape(resolve(root.root), target);
    return { path: target, root };
  }
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoSymlinkEscape(root: string, target: string): Promise<void> {
  const rootReal = await realpath(root);
  const existingTarget = await nearestExistingPath(target);
  const targetReal = await realpath(existingTarget);
  if (!isWithin(rootReal, targetReal)) {
    throw new Error("Path resolves outside its approved root through a symlink or junction.");
  }
}

async function nearestExistingPath(input: string): Promise<string> {
  let current = input;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
