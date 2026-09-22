import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReviewRuntimeDeployment } from "../src/host-breakglass/review-runtime.js";

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gpt-review-runtime-"));
  roots.add(root);
  const installRoot = join(root, "ChatGPT");
  const reviewers = join(installRoot, "Reviewers");
  await mkdir(reviewers, { recursive: true });

  const files = [
    { target: "Reviewers\\Build-ReviewPacket.ps1", content: "Write-Output 'packet'\n" },
    { target: "Reviewers\\Invoke-Review.ps1", content: "Write-Output 'review'\n" },
    { target: "Reviewers\\Get-ReviewerStatus.ps1", content: "Write-Output 'status'\n" }
  ];

  for (const file of files) {
    await writeFile(join(installRoot, ...file.target.split("\\")), file.content, "utf8");
  }

  const sourceSha = "a".repeat(40);
  const receipt = {
    schema: "zerebralis.review-runtime-deployment.v1",
    repository: "Zerebralis/local-ai-agent",
    review_runtime_version: "2.4.0",
    source_sha: sourceSha,
    install_root: installRoot,
    installed_at: "2026-09-22T00:00:00Z",
    policy_managed: false,
    secrets_managed: false,
    files: await Promise.all(files.map(async (file) => {
      const path = join(installRoot, ...file.target.split("\\"));
      const bytes = await readFile(path);
      return {
        target: file.target,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length
      };
    }))
  };

  const receiptPath = join(reviewers, "ReviewRuntimeDeployment.json");
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2), "utf8");
  await writeFile(receiptPath, receiptBytes);
  const receiptSha = createHash("sha256").update(receiptBytes).digest("hex");
  return { root, installRoot, receiptPath, receiptSha, sourceSha, files };
}

describe("Host Breakglass canonical Review Runtime trust binding", () => {
  it("accepts only a receipt-bound deployment whose installed files still match", async () => {
    const fx = await fixture();
    const verified = await verifyReviewRuntimeDeployment({
      receipt_path: fx.receiptPath,
      expected_receipt_sha256: fx.receiptSha,
      expected_install_root: fx.installRoot,
      expected_runtime_version: "2.4.0",
      expected_source_sha: fx.sourceSha
    });

    expect(verified).toMatchObject({
      receipt_sha256: fx.receiptSha,
      runtime_version: "2.4.0",
      source_sha: fx.sourceSha,
      files_verified: 3
    });
    expect(verified.scripts.build_packet).toMatch(/Build-ReviewPacket\.ps1$/);
    expect(verified.scripts.invoke_review).toMatch(/Invoke-Review\.ps1$/);
    expect(verified.scripts.status).toMatch(/Get-ReviewerStatus\.ps1$/);
  });

  it("fails closed when the deployment receipt changes", async () => {
    const fx = await fixture();
    await writeFile(fx.receiptPath, JSON.stringify({ changed: true }), "utf8");

    await expect(verifyReviewRuntimeDeployment({
      receipt_path: fx.receiptPath,
      expected_receipt_sha256: fx.receiptSha,
      expected_install_root: fx.installRoot,
      expected_runtime_version: "2.4.0",
      expected_source_sha: fx.sourceSha
    })).rejects.toThrow(/receipt hash mismatch/i);
  });

  it("fails closed when a receipt-bound runtime file drifts", async () => {
    const fx = await fixture();
    const target = join(fx.installRoot, ...fx.files[1].target.split("\\"));
    await writeFile(target, "Write-Output 'tampered'\n", "utf8");

    await expect(verifyReviewRuntimeDeployment({
      receipt_path: fx.receiptPath,
      expected_receipt_sha256: fx.receiptSha,
      expected_install_root: fx.installRoot,
      expected_runtime_version: "2.4.0",
      expected_source_sha: fx.sourceSha
    })).rejects.toThrow(/file drift/i);
  });
});
