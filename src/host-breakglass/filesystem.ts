import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
  appendFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostBreakglassContext } from "./context.js";

export async function hostStat(context: HostBreakglassContext, inputPath: string) {
  const resolved = await context.paths.resolve(inputPath, "read");
  const info = await stat(resolved.path);
  return {
    path: resolved.path,
    root_id: resolved.root?.id,
    kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    size: info.size,
    modified_at: info.mtime.toISOString()
  };
}

export async function hostReadFile(
  context: HostBreakglassContext,
  input: { path: string; offset?: number; length?: number }
) {
  const resolved = await context.paths.resolve(input.path, "read");
  const info = await stat(resolved.path);
  if (!info.isFile()) throw new Error("Path is not a file.");

  const offset = Math.max(0, input.offset ?? 0);
  const requestedLength = input.length ?? context.config.limits.max_read_bytes;
  const length = Math.min(requestedLength, context.config.limits.max_read_bytes);
  const available = Math.max(0, info.size - offset);
  const bytesToRead = Math.min(length, available);

  const handle = await open(resolved.path, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    return {
      path: resolved.path,
      root_id: resolved.root?.id,
      offset,
      bytes_read: bytesRead,
      size: info.size,
      truncated: offset + bytesRead < info.size,
      content: buffer.subarray(0, bytesRead).toString("utf8")
    };
  } finally {
    await handle.close();
  }
}

export async function hostWriteFile(
  context: HostBreakglassContext,
  input: { path: string; content: string; mode?: "rewrite" | "append"; create_directories?: boolean }
) {
  const resolved = await context.paths.resolve(input.path, "write");
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > context.config.limits.max_write_bytes) {
    throw new Error(`Write exceeds max_write_bytes (${context.config.limits.max_write_bytes}).`);
  }
  if (input.create_directories) {
    await mkdir(dirname(resolved.path), { recursive: true });
  }

  if ((input.mode ?? "rewrite") === "append") {
    await appendFile(resolved.path, input.content, "utf8");
  } else {
    const tempPath = join(dirname(resolved.path), `.${basename(resolved.path)}.${randomUUID()}.tmp`);
    await writeFile(tempPath, input.content, "utf8");
    try {
      await rename(tempPath, resolved.path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
  const info = await stat(resolved.path);
  return { path: resolved.path, root_id: resolved.root?.id, bytes_written: bytes, size: info.size };
}

export async function hostListDirectory(
  context: HostBreakglassContext,
  input: { path: string; include_hidden?: boolean; limit?: number }
) {
  const resolved = await context.paths.resolve(input.path, "read");
  const limit = Math.min(Math.max(1, input.limit ?? 500), 5_000);
  const entries = await readdir(resolved.path, { withFileTypes: true });
  return {
    path: resolved.path,
    root_id: resolved.root?.id,
    entries: entries
      .filter((entry) => input.include_hidden || !entry.name.startsWith("."))
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
      })),
    truncated: entries.length > limit
  };
}

export async function hostSearch(
  context: HostBreakglassContext,
  input: {
    path: string;
    pattern: string;
    type?: "files" | "content";
    literal?: boolean;
    ignore_case?: boolean;
    include_hidden?: boolean;
  }
) {
  const resolved = await context.paths.resolve(input.path, "read");
  const matcher = buildMatcher(input.pattern, input.literal ?? true, input.ignore_case ?? true);
  const results: Array<{ path: string; line?: number; excerpt?: string }> = [];
  const queue = [resolved.path];
  let filesSeen = 0;
  let truncated = false;

  while (queue.length > 0 && results.length < context.config.limits.max_search_results) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!input.include_hidden && entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      filesSeen += 1;
      if (filesSeen > context.config.limits.max_search_files) {
        truncated = true;
        queue.length = 0;
        break;
      }

      if ((input.type ?? "files") === "files") {
        if (matcher(entry.name)) results.push({ path: entryPath });
      } else {
        const info = await stat(entryPath).catch(() => undefined);
        if (!info || info.size > context.config.limits.max_read_bytes) continue;
        const lines = await readUtf8Lines(entryPath, context.config.limits.max_read_bytes);
        for (let index = 0; index < lines.length; index += 1) {
          if (matcher(lines[index])) {
            results.push({ path: entryPath, line: index + 1, excerpt: lines[index].slice(0, 500) });
            if (results.length >= context.config.limits.max_search_results) break;
          }
        }
      }
      if (results.length >= context.config.limits.max_search_results) {
        truncated = true;
        break;
      }
    }
  }

  return {
    path: resolved.path,
    root_id: resolved.root?.id,
    type: input.type ?? "files",
    results,
    files_scanned: filesSeen,
    truncated
  };
}

function buildMatcher(pattern: string, literal: boolean, ignoreCase: boolean): (value: string) => boolean {
  if (pattern.length === 0) throw new Error("Search pattern must not be empty.");
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (value) => (ignoreCase ? value.toLowerCase() : value).includes(needle);
  }
  const expression = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (value) => expression.test(value);
}

async function readUtf8Lines(path: string, maxBytes: number): Promise<string[]> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const remaining = maxBytes - bytes;
      if (remaining <= 0) break;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}
