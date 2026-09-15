import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { hostApplyChanges } from "../src/host-breakglass/change-pack.js";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { hostFileHash, hostHttpProbe, hostReadMany } from "../src/host-breakglass/diagnostics.js";

const roots = new Set<string>();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gpt-host-harvest-"));
  roots.add(root);
  const config = HostBreakglassConfigSchema.parse({
    enabled: true,
    mode: "safe",
    roots: [{ id: "test", root, read: true, write: true, execute: true }]
  });
  return { root, context: createHostBreakglassContext(config) };
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("Host Breakglass tool harvest", () => {
  it("reads several approved files in one bounded operation", async () => {
    const { root, context } = await fixture();
    const a = join(root, "a.txt"), b = join(root, "b.txt");
    await writeFile(a, "alpha", "utf8");
    await writeFile(b, "bravo", "utf8");

    const result = await hostReadMany(context, { files: [{ path: a }, { path: b }], max_total_bytes: 32 });

    expect(result.returned_files).toBe(2);
    expect(result.total_bytes).toBe(10);
    expect(result.files.map((file) => file.content)).toEqual(["alpha", "bravo"]);
    expect(result.truncated).toBe(false);
  });

  it("streams a stable host file hash", async () => {
    const { root, context } = await fixture();
    const file = join(root, "hash.txt");
    await writeFile(file, "hash-me", "utf8");

    const result = await hostFileHash(context, { path: file });

    expect(result.algorithm).toBe("sha256");
    expect(result.hash).toBe(createHash("sha256").update("hash-me").digest("hex"));
  });

  it("dry-runs and applies a guarded multi-file change pack", async () => {
    const { root, context } = await fixture();
    const a = join(root, "a.txt"), b = join(root, "b.txt");
    await writeFile(a, "old-a", "utf8");
    const expected = createHash("sha256").update("old-a").digest("hex");
    const changes = [
      { type: "replace" as const, path: a, find: "old-a", replace: "new-a", expected_old_sha256: expected },
      { type: "write" as const, path: b, content: "new-b", expected_missing: true }
    ];

    const preview = await hostApplyChanges(context, { changes, dry_run: true });
    expect(preview.dry_run).toBe(true);
    expect(await readFile(a, "utf8")).toBe("old-a");

    const applied = await hostApplyChanges(context, { changes });
    expect(applied.applied).toBe(2);
    expect(await readFile(a, "utf8")).toBe("new-a");
    expect(await readFile(b, "utf8")).toBe("new-b");
  });

  it("rolls back earlier writes when a later change fails during apply", async () => {
    const { root, context } = await fixture();
    const a = join(root, "a.txt");
    await writeFile(a, "before", "utf8");
    const missingParentTarget = join(root, "missing-parent", "b.txt");

    await expect(hostApplyChanges(context, { changes: [
      { type: "write", path: a, content: "after" },
      { type: "write", path: missingParentTarget, content: "cannot-land", create_directories: false }
    ] })).rejects.toThrow(/rolled back/i);

    expect(await readFile(a, "utf8")).toBe("before");
  });

  it("accepts line-oriented input for a managed process", async () => {
    const { root, context } = await fixture();
    const job = context.processes.start({
      executable: process.execPath,
      args: ["-e", "process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { process.stdout.write('GOT:'+d.trim()); process.exit(0); });"],
      cwd: root,
      timeout_ms: 5_000
    });

    await context.processes.input(job.job_id, "hello\n", true);
    for (let attempt = 0; attempt < 50 && context.processes.output(job.job_id).status === "running"; attempt += 1) await delay(20);
    const output = context.processes.output(job.job_id);
    expect(output.status).toBe("exited");
    expect(output.stdout_tail).toContain("GOT:hello");
  });

  it("probes loopback HTTP and rejects remote URLs in safe mode", async () => {
    const { context } = await fixture();
    const server = createServer((_req, res) => { res.setHeader("content-type", "text/plain"); res.end("healthy"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port.");
      const result = await hostHttpProbe(context, { url: `http://127.0.0.1:${address.port}/health` });
      expect(result.status).toBe(200);
      expect(result.body).toBe("healthy");
      await expect(hostHttpProbe(context, { url: "https://example.com/" })).rejects.toThrow(/loopback/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds HTTP response bodies without buffering the entire response", async () => {
    const { context } = await fixture();
    const payload = "x".repeat(128 * 1024);
    const server = createServer((_req, res) => { res.setHeader("content-type", "text/plain"); res.end(payload); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port.");
      const result = await hostHttpProbe(context, { url: `http://127.0.0.1:${address.port}/large`, max_body_bytes: 1024 });
      expect(Buffer.byteLength(result.body, "utf8")).toBe(1024);
      expect(result.body_truncated).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a stale change pack before mutating any target", async () => {
    const { root, context } = await fixture();
    const a = join(root, "a.txt"), b = join(root, "b.txt");
    await writeFile(a, "current", "utf8");

    await expect(hostApplyChanges(context, { changes: [
      { type: "replace", path: a, find: "current", replace: "changed", expected_old_sha256: "0".repeat(64) },
      { type: "write", path: b, content: "should-not-exist", expected_missing: true }
    ] })).rejects.toThrow(/File changed/i);

    expect(await readFile(a, "utf8")).toBe("current");
    await expect(readFile(b, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("defaults scheduled task mutations to an empty allowlist", async () => {
    const { context } = await fixture();
    expect(context.config.scheduled_tasks.allowlist).toEqual([]);
  });
});
