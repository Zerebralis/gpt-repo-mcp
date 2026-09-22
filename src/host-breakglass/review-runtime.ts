import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";
import { z } from "zod";
import type { HostBreakglassContext } from "./context.js";
import { isWithin } from "./path-policy.js";

const PINNED_DEPLOYMENT_RECEIPT_SHA256 = "bcdad119e96a6daeca24643e1e0209c1279a7f766f1b84ebba2a64c84ee14929";
const PINNED_RUNTIME_VERSION = "2.4.0";
const PINNED_SOURCE_SHA = "bb28b38bc9ae3e56df1d97044a63807b83ef2842";

const REQUIRED_TARGETS = [
  "Reviewers\\Build-ReviewPacket.ps1",
  "Reviewers\\Invoke-Review.ps1",
  "Reviewers\\Get-ReviewerStatus.ps1"
] as const;

const DeploymentSchema = z.object({
  schema: z.literal("zerebralis.review-runtime-deployment.v1"),
  repository: z.literal("Zerebralis/local-ai-agent"),
  review_runtime_version: z.string().min(1),
  source_sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
  install_root: z.string().min(2),
  installed_at: z.string().min(1),
  policy_managed: z.boolean(),
  secrets_managed: z.boolean(),
  files: z.array(z.object({
    target: z.string().min(1),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    bytes: z.number().int().nonnegative()
  }).strict()).min(1).max(100)
}).strict();

export type VerifiedReviewRuntime = {
  receipt_path: string;
  receipt_sha256: string;
  runtime_version: string;
  source_sha: string;
  install_root: string;
  files_verified: number;
  scripts: {
    build_packet: string;
    invoke_review: string;
    status: string;
  };
};

type VerificationOverrides = {
  receipt_path?: string;
  expected_receipt_sha256?: string;
  expected_install_root?: string;
  expected_runtime_version?: string;
  expected_source_sha?: string;
};

export type HostReviewRuntimeInput = {
  action: "build_packet" | "review" | "status";
  repo_path?: string;
  base_sha?: string;
  candidate_sha?: string;
  instructions_file?: string;
  prompt_file?: string;
  output_file?: string;
  mode?: "Exact" | "Compact";
  contract_files?: string[];
  evidence_files?: string[];
  prior_findings_file?: string;
  diff_paths?: string[];
  reviewer?: "Auto" | "Gemini" | "Qwen" | "GPTOSS" | "OpenRouter";
  review_tier?: "R0" | "R1" | "R2";
  allow_cloud?: boolean;
  advisory_only?: boolean;
  run_groq_scout?: boolean;
  groq_scout_output_file?: string;
  builder_provider?: "Unknown" | "Gemini" | "Qwen" | "GPTOSS" | "OpenRouter" | "Groq" | "OpenAI" | "Other";
  allow_same_provider_fresh_context?: boolean;
  timeout_minutes?: number;
  r2_effort?: "low" | "medium" | "high";
  receipt_file?: string;
  deep?: boolean;
  timeout_ms?: number;
};

const ExactSha = z.string().regex(/^[a-fA-F0-9]{40}$/);
const HostPath = z.string().min(2).max(4_000).refine((value) => !/[\0\r\n]/.test(value), "Path contains a forbidden control character.");
export function isSafeReviewRepoRelativePath(value: string): boolean {
  if (/[\0\r\n:]/.test(value) || isAbsolute(value) || win32.isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").includes("..");
}

const RepoRelativePath = z.string().min(1).max(2_000).refine(
  isSafeReviewRepoRelativePath,
  "Repository path must be relative and must not contain '..', drive letters, or Git pathspec magic."
);

const BuildPacketInput = z.object({
  action: z.literal("build_packet"),
  repo_path: HostPath,
  base_sha: ExactSha,
  candidate_sha: ExactSha,
  instructions_file: HostPath,
  output_file: HostPath,
  mode: z.enum(["Exact", "Compact"]).default("Exact"),
  contract_files: z.array(RepoRelativePath).max(50).default([]),
  evidence_files: z.array(HostPath).max(50).default([]),
  prior_findings_file: HostPath.optional(),
  diff_paths: z.array(RepoRelativePath).max(100).default([]),
  timeout_ms: z.number().int().positive().max(3_600_000).optional()
}).strict();

const ReviewInput = z.object({
  action: z.literal("review"),
  prompt_file: HostPath,
  output_file: HostPath,
  reviewer: z.enum(["Auto", "Gemini", "Qwen", "GPTOSS", "OpenRouter"]).default("Auto"),
  review_tier: z.enum(["R0", "R1", "R2"]).default("R1"),
  allow_cloud: z.boolean().default(false),
  advisory_only: z.boolean().default(false),
  run_groq_scout: z.boolean().default(false),
  groq_scout_output_file: HostPath.optional(),
  builder_provider: z.enum(["Unknown", "Gemini", "Qwen", "GPTOSS", "OpenRouter", "Groq", "OpenAI", "Other"]).default("Unknown"),
  allow_same_provider_fresh_context: z.boolean().default(false),
  timeout_minutes: z.number().int().min(1).max(30).default(5),
  r2_effort: z.enum(["low", "medium", "high"]).default("medium"),
  repo_path: HostPath,
  base_sha: ExactSha,
  candidate_sha: ExactSha,
  receipt_file: HostPath,
  timeout_ms: z.number().int().positive().max(3_600_000).optional()
}).strict();

const StatusInput = z.object({
  action: z.literal("status"),
  deep: z.boolean().default(false),
  timeout_ms: z.number().int().positive().max(120_000).optional()
}).strict();

function defaultReceiptPath(): string {
  if (process.platform !== "win32") throw new Error("The canonical Review Runtime bridge is Windows-only.");
  const profile = process.env.USERPROFILE;
  if (!profile) throw new Error("USERPROFILE is unavailable; cannot locate the canonical Review Runtime.");
  return join(profile, "Documents", "ChatGPT", "Reviewers", "ReviewRuntimeDeployment.json");
}

function defaultInstallRoot(): string {
  const profile = process.env.USERPROFILE;
  if (!profile) throw new Error("USERPROFILE is unavailable; cannot locate the canonical Review Runtime.");
  return resolve(join(profile, "Documents", "ChatGPT"));
}

async function sha256File(path: string): Promise<{ hash: string; bytes: number }> {
  const bytes = await readFile(path);
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length
  };
}

function assertTrustedTarget(installRoot: string, target: string): string {
  if (isAbsolute(target) || win32.isAbsolute(target) || /[\0\r\n]/.test(target)) {
    throw new Error("Review Runtime receipt contains an unsafe target path.");
  }
  const parts = target.split(/[\\/]+/);
  if (parts.includes("..")) throw new Error("Review Runtime receipt contains a path traversal target.");
  const full = resolve(installRoot, parts.join(sep));
  if (!isWithin(installRoot, full)) throw new Error("Review Runtime receipt target escapes install_root.");
  return full;
}

export async function verifyReviewRuntimeDeployment(overrides: VerificationOverrides = {}): Promise<VerifiedReviewRuntime> {
  const receiptPath = resolve(overrides.receipt_path ?? defaultReceiptPath());
  const expectedReceiptSha = (overrides.expected_receipt_sha256 ?? PINNED_DEPLOYMENT_RECEIPT_SHA256).toLowerCase();
  const expectedInstallRoot = resolve(overrides.expected_install_root ?? defaultInstallRoot());
  const expectedVersion = overrides.expected_runtime_version ?? PINNED_RUNTIME_VERSION;
  const expectedSourceSha = (overrides.expected_source_sha ?? PINNED_SOURCE_SHA).toLowerCase();

  const receiptBytes = await readFile(receiptPath);
  const receiptSha = createHash("sha256").update(receiptBytes).digest("hex");
  if (receiptSha !== expectedReceiptSha) {
    throw new Error(`Review Runtime deployment receipt hash mismatch: expected ${expectedReceiptSha}, got ${receiptSha}. Refusing execution until the Breakglass trust pin is updated by reviewed source.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(receiptBytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Review Runtime deployment receipt is not valid JSON.");
  }
  const receipt = DeploymentSchema.parse(raw);
  if (receipt.review_runtime_version !== expectedVersion) {
    throw new Error(`Review Runtime version mismatch: expected ${expectedVersion}, got ${receipt.review_runtime_version}.`);
  }
  if (receipt.source_sha.toLowerCase() !== expectedSourceSha) {
    throw new Error(`Review Runtime source SHA mismatch: expected ${expectedSourceSha}, got ${receipt.source_sha.toLowerCase()}.`);
  }

  const installRoot = resolve(receipt.install_root);
  if (installRoot.toLowerCase() !== expectedInstallRoot.toLowerCase()) {
    throw new Error(`Review Runtime install_root mismatch: expected ${expectedInstallRoot}, got ${installRoot}.`);
  }

  const byTarget = new Map<string, string>();
  for (const entry of receipt.files) {
    const full = assertTrustedTarget(installRoot, entry.target);
    const observed = await sha256File(full);
    if (observed.bytes !== entry.bytes || observed.hash !== entry.sha256.toLowerCase()) {
      throw new Error(`Review Runtime file drift: ${entry.target}. Refusing structured review execution.`);
    }
    byTarget.set(entry.target.toLowerCase(), full);
  }

  for (const target of REQUIRED_TARGETS) {
    if (!byTarget.has(target.toLowerCase())) throw new Error(`Review Runtime deployment receipt is missing required target: ${target}.`);
  }

  return {
    receipt_path: receiptPath,
    receipt_sha256: receiptSha,
    runtime_version: receipt.review_runtime_version,
    source_sha: receipt.source_sha.toLowerCase(),
    install_root: installRoot,
    files_verified: receipt.files.length,
    scripts: {
      build_packet: byTarget.get(REQUIRED_TARGETS[0].toLowerCase())!,
      invoke_review: byTarget.get(REQUIRED_TARGETS[1].toLowerCase())!,
      status: byTarget.get(REQUIRED_TARGETS[2].toLowerCase())!
    }
  };
}

function psQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Review Runtime argument contains a forbidden control character.");
  return "'" + value.replaceAll("'", "''") + "'";
}

function psArray(values: string[]): string {
  return "@(" + values.map(psQuote).join(",") + ")";
}

function commandForBuildPacket(runtime: VerifiedReviewRuntime, input: z.infer<typeof BuildPacketInput>): string {
  const parts = [
    "& " + psQuote(runtime.scripts.build_packet),
    "-RepoPath " + psQuote(input.repo_path),
    "-BaseSha " + psQuote(input.base_sha),
    "-CandidateSha " + psQuote(input.candidate_sha),
    "-InstructionsFile " + psQuote(input.instructions_file),
    "-OutputFile " + psQuote(input.output_file),
    "-Mode " + psQuote(input.mode)
  ];
  if (input.contract_files.length) parts.push("-ContractFiles " + psArray(input.contract_files));
  if (input.evidence_files.length) parts.push("-EvidenceFiles " + psArray(input.evidence_files));
  if (input.prior_findings_file) parts.push("-PriorFindingsFile " + psQuote(input.prior_findings_file));
  if (input.diff_paths.length) parts.push("-DiffPaths " + psArray(input.diff_paths));
  return parts.join(" ");
}

function commandForReview(runtime: VerifiedReviewRuntime, input: z.infer<typeof ReviewInput>): string {
  const parts = [
    "& " + psQuote(runtime.scripts.invoke_review),
    "-Reviewer " + psQuote(input.reviewer),
    "-ReviewTier " + psQuote(input.review_tier),
    "-PromptFile " + psQuote(input.prompt_file),
    "-OutputFile " + psQuote(input.output_file),
    "-BuilderProvider " + psQuote(input.builder_provider),
    "-TimeoutMinutes " + String(input.timeout_minutes),
    "-R2Effort " + psQuote(input.r2_effort),
    "-RepoPath " + psQuote(input.repo_path),
    "-BaseSha " + psQuote(input.base_sha),
    "-CandidateSha " + psQuote(input.candidate_sha),
    "-ReceiptFile " + psQuote(input.receipt_file)
  ];
  if (input.allow_cloud) parts.push("-AllowCloud");
  if (input.advisory_only) parts.push("-AdvisoryOnly");
  if (input.run_groq_scout) {
    if (!input.groq_scout_output_file) throw new Error("groq_scout_output_file is required when run_groq_scout=true.");
    parts.push("-RunGroqScout");
    parts.push("-GroqScoutOutputFile " + psQuote(input.groq_scout_output_file));
  }
  if (input.allow_same_provider_fresh_context) parts.push("-AllowSameProviderFreshContext");
  return parts.join(" ");
}

function powershellInvocation(command: string): { executable: string; args: string[] } {
  if (command.length > 28_000) throw new Error("Structured Review Runtime invocation exceeds the bounded PowerShell command length.");
  return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
  };
}

async function assertFile(path: string, label: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

async function resolveReadFile(context: HostBreakglassContext, path: string, label: string): Promise<string> {
  const resolved = await context.paths.resolve(path, "read");
  await assertFile(resolved.path, label);
  return resolved.path;
}

async function resolveWriteTarget(context: HostBreakglassContext, path: string): Promise<string> {
  const resolved = await context.paths.resolve(path, "write");
  return resolved.path;
}

async function resolveRepo(context: HostBreakglassContext, path: string): Promise<string> {
  const resolved = await context.paths.resolve(path, "read");
  await assertDirectory(resolved.path, "repo_path");
  return resolved.path;
}

export async function hostReviewRuntime(context: HostBreakglassContext, raw: HostReviewRuntimeInput) {
  await verifyReviewRuntimeDeployment();

  if (raw.action === "status") {
    const input = StatusInput.parse(raw);
    const launchRuntime = await verifyReviewRuntimeDeployment();
    const command = "& " + psQuote(launchRuntime.scripts.status) + (input.deep ? " -Deep" : "");
    const invocation = powershellInvocation(command);
    const job = context.processes.start({
      executable: invocation.executable,
      args: invocation.args,
      cwd: join(launchRuntime.install_root, "Reviewers"),
      timeout_ms: input.timeout_ms ?? 60_000
    });
    return { action: input.action, runtime: runtimeIdentity(launchRuntime), job };
  }

  if (raw.action === "build_packet") {
    const input = BuildPacketInput.parse(raw);
    const repoPath = await resolveRepo(context, input.repo_path);
    const instructionsFile = await resolveReadFile(context, input.instructions_file, "instructions_file");
    const outputFile = await resolveWriteTarget(context, input.output_file);
    const evidenceFiles = [];
    for (const file of input.evidence_files) evidenceFiles.push(await resolveReadFile(context, file, "evidence_file"));
    const priorFindingsFile = input.prior_findings_file
      ? await resolveReadFile(context, input.prior_findings_file, "prior_findings_file")
      : undefined;

    const normalized = { ...input, repo_path: repoPath, instructions_file: instructionsFile, output_file: outputFile, evidence_files: evidenceFiles, prior_findings_file: priorFindingsFile };
    const launchRuntime = await verifyReviewRuntimeDeployment();
    const invocation = powershellInvocation(commandForBuildPacket(launchRuntime, normalized));
    const job = context.processes.start({
      executable: invocation.executable,
      args: invocation.args,
      cwd: join(launchRuntime.install_root, "Reviewers"),
      timeout_ms: input.timeout_ms ?? 300_000
    });
    return { action: input.action, runtime: runtimeIdentity(launchRuntime), job, output_file: outputFile };
  }

  const input = ReviewInput.parse(raw);
  const repoPath = await resolveRepo(context, input.repo_path);
  const promptFile = await resolveReadFile(context, input.prompt_file, "prompt_file");
  if (input.review_tier === "R2") {
    await resolveReadFile(context, promptFile + ".meta.json", "R2 packet metadata");
  }
  const outputFile = await resolveWriteTarget(context, input.output_file);
  const receiptFile = await resolveWriteTarget(context, input.receipt_file);
  const groqScoutOutputFile = input.groq_scout_output_file
    ? await resolveWriteTarget(context, input.groq_scout_output_file)
    : undefined;

  const normalized = {
    ...input,
    repo_path: repoPath,
    prompt_file: promptFile,
    output_file: outputFile,
    receipt_file: receiptFile,
    groq_scout_output_file: groqScoutOutputFile
  };
  const launchRuntime = await verifyReviewRuntimeDeployment();
  const invocation = powershellInvocation(commandForReview(launchRuntime, normalized));
  const processTimeout = input.timeout_ms ?? Math.min(3_600_000, (input.timeout_minutes + 2) * 60_000);
  const job = context.processes.start({
    executable: invocation.executable,
    args: invocation.args,
    cwd: join(launchRuntime.install_root, "Reviewers"),
    timeout_ms: processTimeout
  });
  return { action: input.action, runtime: runtimeIdentity(launchRuntime), job, output_file: outputFile, receipt_file: receiptFile };
}

function runtimeIdentity(runtime: VerifiedReviewRuntime) {
  return {
    runtime_version: runtime.runtime_version,
    source_sha: runtime.source_sha,
    deployment_receipt_sha256: runtime.receipt_sha256,
    files_verified: runtime.files_verified
  };
}
