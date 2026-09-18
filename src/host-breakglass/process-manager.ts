import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { minimalHostEnv } from "./shell-policy.js";

export type HostManagedProcessStatus = "running" | "exited" | "failed" | "killed" | "timed_out";

export type HostManagedProcessView = {
  job_id: string;
  pid?: number;
  executable: string;
  cwd: string;
  status: HostManagedProcessStatus;
  started_at: string;
  ended_at?: string;
  exit_code?: number;
  signal?: string;
  stdout_tail: string;
  stderr_tail: string;
};

type ManagedProcess = HostManagedProcessView & {
  child: ChildProcess;
  timer?: NodeJS.Timeout;
};

export class HostProcessManager {
  private readonly jobs = new Map<string, ManagedProcess>();

  constructor(
    private readonly maxProcesses: number,
    private readonly maxOutputBytes: number
  ) {}

  start(input: {
    executable: string;
    args?: string[];
    cwd: string;
    env?: Record<string, string>;
    timeout_ms?: number;
  }): HostManagedProcessView {
    this.sweepFinished();
    const runningCount = [...this.jobs.values()].filter((job) => job.status === "running").length;
    if (runningCount >= this.maxProcesses) {
      throw new Error(`Managed process limit reached (${this.maxProcesses}).`);
    }

    const child = spawn(input.executable, input.args ?? [], {
      cwd: input.cwd,
      env: minimalHostEnv(input.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const jobId = randomUUID();
    const job: ManagedProcess = {
      job_id: jobId,
      pid: child.pid,
      executable: basename(input.executable),
      cwd: input.cwd,
      status: "running",
      started_at: new Date().toISOString(),
      stdout_tail: "",
      stderr_tail: "",
      child
    };
    this.jobs.set(jobId, job);

    child.stdout?.on("data", (chunk: Buffer) => {
      job.stdout_tail = appendTail(job.stdout_tail, chunk, this.maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      job.stderr_tail = appendTail(job.stderr_tail, chunk, this.maxOutputBytes);
    });
    child.once("error", (error) => {
      if (job.status === "running") {
        job.status = "failed";
        job.ended_at = new Date().toISOString();
        job.stderr_tail = appendTail(job.stderr_tail, Buffer.from(describeSpawnError(error, input)), this.maxOutputBytes);
      }
      if (job.timer) clearTimeout(job.timer);
    });
    child.once("close", (code, signal) => {
      if (job.status === "running") {
        job.status = "exited";
      }
      job.exit_code = typeof code === "number" ? code : undefined;
      job.signal = signal ?? undefined;
      job.ended_at = new Date().toISOString();
      if (job.timer) clearTimeout(job.timer);
    });

    if (input.timeout_ms) {
      job.timer = setTimeout(() => {
        if (job.status !== "running") return;
        job.status = "timed_out";
        this.terminate(job);
      }, input.timeout_ms);
      job.timer.unref();
    }

    return this.view(job);
  }

  output(jobId: string): HostManagedProcessView {
    const job = this.require(jobId);
    return this.view(job);
  }

  async input(jobId: string, chars: string, end = false): Promise<HostManagedProcessView> {
    const job = this.require(jobId);
    if (job.status !== "running") throw new Error(`Managed job is not running: ${jobId}`);
    const stdin = job.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error(`Managed job stdin is not writable: ${jobId}`);
    if (chars.length > 100_000) throw new Error("Managed process input exceeds 100000 characters.");
    if (chars) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onDrain = () => { cleanup(); resolve(); };
        const cleanup = () => { stdin.off("error", onError); stdin.off("drain", onDrain); };
        stdin.once("error", onError);
        const accepted = stdin.write(chars, "utf8");
        if (accepted) { cleanup(); resolve(); } else stdin.once("drain", onDrain);
      });
    }
    if (end) stdin.end();
    return this.view(job);
  }

  list(): HostManagedProcessView[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .map((job) => this.view(job));
  }

  kill(jobId: string): HostManagedProcessView {
    const job = this.require(jobId);
    if (job.status === "running") {
      job.status = "killed";
      this.terminate(job);
    }
    return this.view(job);
  }

  private terminate(job: ManagedProcess): void {
    if (!job.child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(job.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        env: minimalHostEnv()
      });
      killer.once("error", () => job.child.kill("SIGKILL"));
      killer.unref();
      return;
    }
    job.child.kill("SIGTERM");
  }

  private require(jobId: string): ManagedProcess {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown managed job: ${jobId}`);
    return job;
  }

  private view(job: ManagedProcess): HostManagedProcessView {
    return {
      job_id: job.job_id,
      pid: job.pid,
      executable: job.executable,
      cwd: job.cwd,
      status: job.status,
      started_at: job.started_at,
      ended_at: job.ended_at,
      exit_code: job.exit_code,
      signal: job.signal,
      stdout_tail: job.stdout_tail,
      stderr_tail: job.stderr_tail
    };
  }

  private sweepFinished(): void {
    if (this.jobs.size <= this.maxProcesses * 4) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (const job of finished.slice(0, Math.max(0, this.jobs.size - this.maxProcesses * 3))) {
      this.jobs.delete(job.job_id);
    }
  }
}

function describeSpawnError(error: Error, input: { executable: string; cwd: string }): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    if (!existsSync(input.cwd)) {
      return `HOST_PROCESS_CWD_NOT_FOUND: Working directory does not exist: ${input.cwd}. Refresh the repository/worktree path before retrying; do not treat this as an executable-not-found failure.`;
    }
    return `HOST_PROCESS_EXECUTABLE_NOT_FOUND: Executable could not be resolved: ${input.executable}. The working directory still exists.`;
  }
  return error.message;
}

function appendTail(current: string, chunk: Buffer, maxBytes: number): string {
  const combined = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
  return combined.subarray(Math.max(0, combined.length - maxBytes)).toString("utf8");
}
