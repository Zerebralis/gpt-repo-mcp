import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { HostBreakglassContext } from "./context.js";
import { hostReadFile } from "./filesystem.js";

export async function hostReadMany(
  context: HostBreakglassContext,
  input: { files: Array<{ path: string; offset?: number; length?: number }>; max_total_bytes?: number }
) {
  if (input.files.length === 0) throw new Error("At least one file is required.");
  if (input.files.length > 20) throw new Error("host_read_many accepts at most 20 files.");
  const hardCap = Math.min(4 * 1024 * 1024, context.config.limits.max_read_bytes * 4);
  const totalLimit = Math.min(Math.max(1, input.max_total_bytes ?? 1024 * 1024), hardCap);
  const files = [];
  let totalBytes = 0;
  let truncated = false;
  for (const requested of input.files) {
    const remaining = totalLimit - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const length = Math.min(requested.length ?? remaining, remaining);
    const result = await hostReadFile(context, { ...requested, length });
    totalBytes += result.bytes_read;
    files.push(result);
    if (result.truncated && (requested.length === undefined || result.bytes_read >= length)) truncated = true;
  }
  if (files.length < input.files.length) truncated = true;
  return { files, requested_files: input.files.length, returned_files: files.length, total_bytes: totalBytes, max_total_bytes: totalLimit, truncated };
}

export async function hostFileHash(context: HostBreakglassContext, input: { path: string; algorithm?: "sha256" | "sha512" }) {
  const resolved = await context.paths.resolve(input.path, "read");
  const info = await stat(resolved.path);
  if (!info.isFile()) throw new Error("Path is not a file.");
  const algorithm = input.algorithm ?? "sha256";
  const hash = createHash(algorithm);
  const stream = createReadStream(resolved.path, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return { path: resolved.path, root_id: resolved.root?.id, algorithm, hash: hash.digest("hex"), size: info.size, modified_at: info.mtime.toISOString() };
}

export async function hostHttpProbe(
  context: HostBreakglassContext,
  input: { url: string; method?: "HEAD" | "GET"; timeout_ms?: number; max_body_bytes?: number; approval?: string }
) {
  const url = new URL(input.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Only credential-free http/https URLs are supported.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (!loopback && !(context.config.mode === "full" && input.approval === "HOST_BREAKGLASS_FULL")) {
    throw new Error("Safe mode HTTP probes are limited to loopback. Full mode plus HOST_BREAKGLASS_FULL is required for remote URLs.");
  }
  const timeoutMs = Math.min(Math.max(1, input.timeout_ms ?? 5_000), context.config.limits.max_timeout_ms, 30_000);
  const maxBodyBytes = Math.min(Math.max(0, input.max_body_bytes ?? 8_192), 65_536);
  const started = Date.now();
  const response = await fetch(url, { method: input.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  let body = "";
  let bodyTruncated = false;
  if ((input.method ?? "GET") === "GET" && maxBodyBytes > 0 && response.body) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let collected = 0;
    try {
      while (collected <= maxBodyBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        const remaining = maxBodyBytes + 1 - collected;
        if (remaining > 0) {
          const kept = chunk.subarray(0, remaining);
          chunks.push(kept);
          collected += kept.length;
        }
        if (collected > maxBodyBytes || chunk.length > remaining) {
          bodyTruncated = true;
          break;
        }
      }
    } finally {
      if (bodyTruncated) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
    bodyTruncated ||= buffer.length > maxBodyBytes;
    body = buffer.subarray(0, maxBodyBytes).toString("utf8");
  }
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "location", "server"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { url: url.toString(), loopback, method: input.method ?? "GET", status: response.status, ok: response.ok, duration_ms: Date.now() - started, headers, body, body_truncated: bodyTruncated };
}
