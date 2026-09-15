import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import type { HostBreakglassContext } from "./context.js";
import { hostReadFile, hostWriteFile } from "./filesystem.js";

type Change =
  | { type: "write"; path: string; content: string; create_directories?: boolean; expected_old_sha256?: string; expected_missing?: boolean }
  | { type: "replace"; path: string; find: string; replace: string; replace_all?: boolean; expected_old_sha256?: string };

type Snapshot = { path: string; existed: boolean; content?: string; sha256?: string };
type PreparedChange = {
  change: Change;
  snapshot: Snapshot;
  nextContent: string;
  before_sha256?: string;
  after_sha256: string;
  bytes_after: number;
};

export async function hostApplyChanges(
  context: HostBreakglassContext,
  input: { changes: Change[]; dry_run?: boolean }
) {
  if (input.changes.length === 0) throw new Error("At least one change is required.");
  if (input.changes.length > 25) throw new Error("At most 25 changes are allowed.");
  const seen = new Set<string>();
  const prepared: PreparedChange[] = [];

  for (const change of input.changes) {
    const resolved = await context.paths.resolve(change.path, "write");
    const key = resolved.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate target path in one change pack: ${change.path}`);
    seen.add(key);

    const snapshot = await snapshotFile(context, resolved.path);
    let nextContent: string;
    if (change.type === "write") {
      if (change.expected_missing && snapshot.existed) throw new Error(`Expected missing file already exists: ${change.path}`);
      assertExpectedHash(snapshot.sha256, change.expected_old_sha256, change.path);
      nextContent = change.content;
    } else {
      if (!snapshot.existed || snapshot.content === undefined) throw new Error(`Replace target does not exist: ${change.path}`);
      assertExpectedHash(snapshot.sha256, change.expected_old_sha256, change.path);
      const count = countOccurrences(snapshot.content, change.find);
      if (count === 0) throw new Error(`replace.find was not found in ${change.path}`);
      if (!change.replace_all && count !== 1) throw new Error(`replace.find occurs ${count} times in ${change.path}; use a unique anchor or replace_all=true.`);
      nextContent = change.replace_all ? snapshot.content.split(change.find).join(change.replace) : snapshot.content.replace(change.find, change.replace);
    }

    const bytesAfter = Buffer.byteLength(nextContent, "utf8");
    if (bytesAfter > context.config.limits.max_write_bytes) {
      throw new Error(`Change exceeds max_write_bytes (${context.config.limits.max_write_bytes}): ${change.path}`);
    }
    prepared.push({
      change,
      snapshot,
      nextContent,
      before_sha256: snapshot.sha256,
      after_sha256: sha256(nextContent),
      bytes_after: bytesAfter
    });
  }

  const plan = prepared.map(({ change, snapshot, before_sha256, after_sha256, bytes_after }) => ({
    type: change.type,
    path: change.path,
    existed_before: snapshot.existed,
    before_sha256,
    after_sha256,
    bytes_after
  }));
  if (input.dry_run) return { dry_run: true, changes: plan };

  const applied: PreparedChange[] = [];
  try {
    for (const entry of prepared) {
      const current = await fileState(entry.snapshot.path);
      assertSnapshotUnchanged(entry.snapshot, current, entry.change.path);
      await hostWriteFile(context, {
        path: entry.change.path,
        content: entry.nextContent,
        mode: "rewrite",
        create_directories: entry.change.type === "write" ? entry.change.create_directories : false
      });
      applied.push(entry);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of [...applied].reverse()) {
      try {
        const current = await fileState(entry.snapshot.path);
        if (!current.existed || current.sha256?.toLowerCase() !== entry.after_sha256.toLowerCase()) {
          throw new Error(`target changed after apply; refusing to overwrite during rollback`);
        }
        if (entry.snapshot.existed) {
          await hostWriteFile(context, {
            path: entry.change.path,
            content: entry.snapshot.content ?? "",
            mode: "rewrite",
            create_directories: true
          });
        } else {
          const resolved = await context.paths.resolve(entry.change.path, "write");
          await unlink(resolved.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.change.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length) throw new Error(`Change pack failed: ${detail}. Rollback also had errors: ${rollbackErrors.join(" | ")}`);
    throw new Error(`Change pack failed and applied changes were rolled back: ${detail}`);
  }

  return { dry_run: false, applied: plan.length, changes: plan, rollback_on_failure: true };
}

async function snapshotFile(context: HostBreakglassContext, path: string): Promise<Snapshot> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Change target is not a file: ${path}`);
    const read = await hostReadFile(context, { path });
    if (read.truncated) throw new Error(`Change target exceeds max_read_bytes and cannot be safely snapshotted: ${path}`);
    return { path, existed: true, content: read.content, sha256: sha256(read.content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { path, existed: false };
    throw error;
  }
}

async function fileState(path: string): Promise<Pick<Snapshot, "existed" | "sha256">> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Change target is not a file: ${path}`);
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return { existed: true, sha256: hash.digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { existed: false };
    throw error;
  }
}

function assertSnapshotUnchanged(expected: Snapshot, actual: Pick<Snapshot, "existed" | "sha256">, path: string): void {
  if (expected.existed !== actual.existed) throw new Error(`Target existence changed after preflight: ${path}`);
  if (expected.existed && expected.sha256?.toLowerCase() !== actual.sha256?.toLowerCase()) {
    throw new Error(`Target changed after preflight: ${path}`);
  }
}

function assertExpectedHash(actual: string | undefined, expected: string | undefined, path: string): void {
  if (!expected) return;
  if (!actual || actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`File changed: ${path}. expected_sha256=${expected} actual_sha256=${actual ?? "missing"}`);
}
function sha256(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function countOccurrences(haystack: string, needle: string): number { let count = 0; let offset = 0; while (true) { const next = haystack.indexOf(needle, offset); if (next < 0) return count; count += 1; offset = next + needle.length; } }