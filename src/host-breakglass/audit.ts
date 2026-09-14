import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type HostAuditEvent = {
  action: string;
  ok: boolean;
  duration_ms: number;
  root_id?: string;
  target_kind?: string;
  command_hash?: string;
  pid?: number;
  detail?: string;
};

export class HostAuditLog {
  constructor(private readonly path?: string) {}

  async write(event: HostAuditEvent): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      ...event,
      detail: event.detail?.slice(0, 240)
    };
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
