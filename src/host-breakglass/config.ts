import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const PositiveIntSchema = z.number().int().positive();

export const HostRootSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/),
  root: z.string().min(1),
  read: z.boolean().default(true),
  write: z.boolean().default(false),
  execute: z.boolean().default(false)
}).strict();

export const HostBreakglassConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["safe", "full"]).default("safe"),
  full_host_access: z.boolean().default(false),
  roots: z.array(HostRootSchema).default([]),
  limits: z.object({
    max_read_bytes: PositiveIntSchema.max(64 * 1024 * 1024).default(8 * 1024 * 1024),
    max_write_bytes: PositiveIntSchema.max(64 * 1024 * 1024).default(8 * 1024 * 1024),
    max_output_bytes: PositiveIntSchema.max(8 * 1024 * 1024).default(256 * 1024),
    max_processes: PositiveIntSchema.max(100).default(24),
    default_timeout_ms: PositiveIntSchema.max(3_600_000).default(120_000),
    max_timeout_ms: PositiveIntSchema.max(3_600_000).default(3_600_000),
    max_search_results: PositiveIntSchema.max(5_000).default(250),
    max_search_files: PositiveIntSchema.max(100_000).default(20_000)
  }).strict().default({
    max_read_bytes: 8 * 1024 * 1024,
    max_write_bytes: 8 * 1024 * 1024,
    max_output_bytes: 256 * 1024,
    max_processes: 24,
    default_timeout_ms: 120_000,
    max_timeout_ms: 3_600_000,
    max_search_results: 250,
    max_search_files: 20_000
  }),
  git: z.object({
    allow_push: z.boolean().default(true),
    allow_merge: z.boolean().default(true),
    allowed_remotes: z.array(z.string().min(1)).default(["origin"])
  }).strict().default({
    allow_push: true,
    allow_merge: true,
    allowed_remotes: ["origin"]
  }),
  registry: z.object({
    write_hives: z.array(z.enum(["HKCU", "HKLM", "HKCR", "HKU", "HKCC"])).default(["HKCU"])
  }).strict().default({
    write_hives: ["HKCU"]
  }),
  services: z.object({
    allowlist: z.array(z.string().min(1)).default([])
  }).strict().default({
    allowlist: []
  }),
  audit_path: z.string().min(1).optional()
}).strict().superRefine((config, ctx) => {
  if (config.full_host_access && config.mode !== "full") {
    ctx.addIssue({ code: "custom", path: ["full_host_access"], message: "full_host_access requires mode=full" });
  }
  const ids = new Set<string>();
  for (const [index, entry] of config.roots.entries()) {
    if (!isAbsolute(entry.root)) {
      ctx.addIssue({ code: "custom", path: ["roots", index, "root"], message: "Host roots must be absolute paths" });
    }
    if (ids.has(entry.id)) {
      ctx.addIssue({ code: "custom", path: ["roots", index, "id"], message: `Duplicate host root id: ${entry.id}` });
    }
    ids.add(entry.id);
  }
});

export type HostBreakglassConfig = z.infer<typeof HostBreakglassConfigSchema>;
export type HostRootConfig = z.infer<typeof HostRootSchema>;

export async function loadHostBreakglassConfig(path: string): Promise<HostBreakglassConfig> {
  const raw = await readFile(resolve(path), "utf8");
  const config = HostBreakglassConfigSchema.parse(JSON.parse(raw.replace(/^\uFEFF/, "")));
  if (!config.enabled) {
    throw new Error("Host breakglass is disabled in config. Set enabled=true intentionally before starting it.");
  }
  if (config.roots.length === 0 && !config.full_host_access) {
    throw new Error("Host breakglass needs at least one approved root unless full_host_access=true.");
  }
  return config;
}
