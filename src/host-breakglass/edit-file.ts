import { createHash, randomUUID } from "node:crypto";
import { link, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HostBreakglassContext } from "./context.js";
import { hostReadFile } from "./filesystem.js";

export type HostEditFileInput = {
  path: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
  expected_sha256?: string;
};

type HostEditFileHooks = {
  beforeCommit?: () => Promise<void>;
  afterClaim?: () => Promise<void>;
};

const MAX_REPORTED_SPANS = 8;

export async function hostEditFile(
  context: HostBreakglassContext,
  input: HostEditFileInput,
  hooks: HostEditFileHooks = {}
) {
  const current = await hostReadFile(context, { path: input.path });
  if (current.truncated) {
    throw new Error("File is larger than the configured read limit; exact edit refused.");
  }

  const preSha256 = sha256(current.content);
  assertHash(preSha256, input.expected_sha256);

  const spans = occurrenceSpans(current.content, input.old_text, MAX_REPORTED_SPANS);
  const replacementCount = countOccurrences(current.content, input.old_text);
  if (replacementCount === 0) throw new Error("old_text was not found.");
  if (!input.replace_all && replacementCount !== 1) {
    throw new Error(
      `old_text occurs ${replacementCount} times; provide a unique fragment or set replace_all=true.`
    );
  }

  const intendedContent = input.replace_all
    ? current.content.split(input.old_text).join(input.new_text)
    : current.content.replace(input.old_text, input.new_text);
  const intendedPostSha256 = sha256(intendedContent);

  await hooks.beforeCommit?.();
  const write = await compareAndSwapRewrite(context, {
    path: current.path,
    content: intendedContent,
    expectedPreSha256: preSha256,
    expectedPostSha256: intendedPostSha256,
    afterClaim: hooks.afterClaim
  });

  const post = await hostReadFile(context, { path: current.path });
  if (post.truncated) {
    throw new Error(
      "host_edit_file postcondition could not be verified because the post-image exceeds the configured read limit. Do not repeat the edit; re-read the target explicitly."
    );
  }
  const actualPostSha256 = sha256(post.content);
  if (actualPostSha256 !== intendedPostSha256) {
    throw new Error(
      `host_edit_file postcondition failed: expected_post_sha256=${intendedPostSha256} actual_post_sha256=${actualPostSha256}. Do not repeat the edit; reconcile the target first.`
    );
  }

  return {
    path: write.path,
    root_id: write.root_id,
    bytes_written: write.bytes_written,
    size: write.size,
    replacement_count: replacementCount,
    replace_all: input.replace_all ?? false,
    pre_sha256: preSha256,
    post_sha256: actualPostSha256,
    matched_spans: spans,
    matched_spans_truncated: replacementCount > spans.length,
    postcondition: {
      verified: true,
      method: "cas-claim+full-reread-sha256",
      expected_post_sha256: intendedPostSha256,
      reread_bytes: post.bytes_read
    }
  };
}

async function compareAndSwapRewrite(
  context: HostBreakglassContext,
  input: {
    path: string;
    content: string;
    expectedPreSha256: string;
    expectedPostSha256: string;
    afterClaim?: () => Promise<void>;
  }
) {
  const resolved = await context.paths.resolve(input.path, "write");
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > context.config.limits.max_write_bytes) {
    throw new Error(`Write exceeds max_write_bytes (${context.config.limits.max_write_bytes}).`);
  }

  const suffix = randomUUID();
  const tempPath = join(dirname(resolved.path), `.${basename(resolved.path)}.${suffix}.edit.tmp`);
  const backupPath = join(dirname(resolved.path), `.${basename(resolved.path)}.${suffix}.edit.bak`);
  let backupClaimed = false;

  await writeFile(tempPath, input.content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(resolved.path, backupPath);
    backupClaimed = true;

    const claimedInfo = await stat(backupPath);
    if (claimedInfo.size > context.config.limits.max_read_bytes) {
      const restored = await restoreClaimedFile(backupPath, resolved.path);
      backupClaimed = !restored;
      throw new Error("File changed during edit and now exceeds the configured read limit; edit refused.");
    }

    const claimed = await readFile(backupPath);
    const claimedSha256 = sha256Buffer(claimed);
    if (claimedSha256 !== input.expectedPreSha256) {
      const restored = await restoreClaimedFile(backupPath, resolved.path);
      backupClaimed = !restored;
      throw new Error(
        `File changed during edit. expected_pre_sha256=${input.expectedPreSha256} actual_pre_sha256=${claimedSha256}. No replacement was committed.`
      );
    }

    await input.afterClaim?.();

    try {
      await link(tempPath, resolved.path);
    } catch (error) {
      throw concurrentCommitError(error, backupPath);
    }

    const installed = await readFile(resolved.path);
    const installedSha256 = sha256Buffer(installed);
    if (installedSha256 !== input.expectedPostSha256) {
      throw new Error(
        `host_edit_file commit verification failed: expected_post_sha256=${input.expectedPostSha256} actual_post_sha256=${installedSha256}. The pre-edit file is preserved at ${backupPath}; reconcile before retrying.`
      );
    }

    const claimedAfterInstallSha256 = sha256Buffer(await readFile(backupPath));
    if (claimedAfterInstallSha256 !== input.expectedPreSha256) {
      throw new Error(
        `The claimed pre-edit file changed through an existing handle during commit. The installed target and preserved pre-edit bytes must be reconciled at ${backupPath} before retrying.`
      );
    }

    await unlink(backupPath);
    backupClaimed = false;
    const info = await stat(resolved.path);
    return {
      path: resolved.path,
      root_id: resolved.root?.id,
      bytes_written: bytes,
      size: info.size
    };
  } catch (error) {
    if (backupClaimed && !(await pathExists(resolved.path))) {
      const restored = await restoreClaimedFile(backupPath, resolved.path).catch(() => false);
      backupClaimed = !restored;
    }
    if (backupClaimed) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} Pre-edit bytes remain preserved at ${backupPath}; reconcile before retrying.`);
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function restoreClaimedFile(backupPath: string, targetPath: string): Promise<boolean> {
  try {
    await link(backupPath, targetPath);
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
  await unlink(backupPath);
  return true;
}

function concurrentCommitError(error: unknown, backupPath: string): Error {
  if (isCode(error, "EEXIST")) {
    return new Error(
      `Concurrent writer recreated the target while host_edit_file held its commit claim. That writer was not overwritten; the pre-edit file is preserved at ${backupPath}.`
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sha256Buffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertHash(actualHash: string, expectedHash: string | undefined): void {
  if (!expectedHash) return;
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`File changed. expected_sha256=${expectedHash} actual_sha256=${actualHash}`);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function occurrenceSpans(
  haystack: string,
  needle: string,
  limit: number
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (spans.length < limit) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) break;
    spans.push({ start: next, end: next + needle.length });
    offset = next + needle.length;
  }
  return spans;
}
