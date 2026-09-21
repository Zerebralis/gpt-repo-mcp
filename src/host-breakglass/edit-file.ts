import { createHash } from "node:crypto";
import type { HostBreakglassContext } from "./context.js";
import { hostReadFile, hostWriteFile } from "./filesystem.js";

export type HostEditFileInput = {
  path: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
  expected_sha256?: string;
};

const MAX_REPORTED_SPANS = 8;

export async function hostEditFile(context: HostBreakglassContext, input: HostEditFileInput) {
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

  const write = await hostWriteFile(context, {
    path: input.path,
    content: intendedContent,
    mode: "rewrite"
  });

  const post = await hostReadFile(context, { path: input.path });
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
      method: "full-reread-sha256",
      expected_post_sha256: intendedPostSha256,
      reread_bytes: post.bytes_read
    }
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
