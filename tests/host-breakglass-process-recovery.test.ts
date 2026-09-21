import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HostProcessManager } from "../src/host-breakglass/process-manager.js";

const roots = new Set<string>();

async function rootFixture() {
  const root = await mkdtemp(join(tmpdir(), "gpt-host-process-recovery-"));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("managed process observation recovery", () => {
  it("keeps the same live job after an injected output transport failure and preserves exit state", async () => {
    const root = await rootFixture();
    const manager = new HostProcessManager(4, 4096);
    const started = manager.start({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('READY\\n'); setTimeout(()=>process.exit(0),700)"],
      cwd: root
    });

    for (let attempt = 0; attempt < 50 && !manager.output(started.job_id).stdout_tail.includes("READY"); attempt += 1) {
      await delay(10);
    }

    const observeThenLoseTransport = () => {
      manager.output(started.job_id);
      throw new Error("UNAVAILABLE: injected transport failure after manager lookup");
    };
    expect(observeThenLoseTransport).toThrow(/UNAVAILABLE/);

    const reconciled = manager.reconcile(started.job_id);
    expect(reconciled).toMatchObject({
      found: true,
      manager_state: "running",
      job_id: started.job_id,
      job: {
        job_id: started.job_id,
        pid: started.pid,
        status: "running"
      }
    });
    expect(manager.list().filter((job) => job.job_id === started.job_id)).toHaveLength(1);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = manager.reconcile(started.job_id);
      if (state.found && state.manager_state === "terminal") break;
      await delay(10);
    }

    const terminal = manager.reconcile(started.job_id);
    expect(terminal).toMatchObject({
      found: true,
      manager_state: "terminal",
      job_id: started.job_id,
      job: {
        job_id: started.job_id,
        pid: started.pid,
        status: "exited",
        exit_code: 0
      }
    });
  });

  it("keeps an unknown job id separate and never adopts another job by PID", async () => {
    const root = await rootFixture();
    const manager = new HostProcessManager(4, 4096);
    const known = manager.start({
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>process.exit(0),150)"],
      cwd: root
    });
    const unknownId = randomUUID();

    const unknown = manager.reconcile(unknownId);
    expect(unknown).toMatchObject({
      job_id: unknownId,
      found: false,
      manager_state: "unknown"
    });
    expect("job" in unknown).toBe(false);

    const knownState = manager.reconcile(known.job_id);
    expect(knownState).toMatchObject({
      found: true,
      job: { job_id: known.job_id, pid: known.pid }
    });
    expect(known.job_id).not.toBe(unknownId);

    await delay(250);
  });
});
