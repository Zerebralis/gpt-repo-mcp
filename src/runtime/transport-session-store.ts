export type ClosableTransport = {
  close(): Promise<void>;
};

export type SessionReservation<T extends ClosableTransport> = {
  commit(sessionId: string, transport: T): void;
  release(): void;
};

export type SessionLease<T extends ClosableTransport> = {
  transport: T;
  release(): void;
};

type SessionEntry<T> = {
  transport: T;
  lastAccessedAt: number;
  inFlight: number;
};

export class TransportSessionStore<T extends ClosableTransport> {
  private readonly sessions = new Map<string, SessionEntry<T>>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly pressureIdleTtlMs?: number;
  private readonly pressureSoftTarget: number;
  private readonly now: () => number;
  private reservations = 0;
  private committed = 0;
  private normalExpired = 0;
  private pressureReclaimed = 0;
  private admissionRejected = 0;

  constructor(options: { maxSessions: number; idleTtlMs: number; pressureIdleTtlMs?: number; pressureSoftTarget?: number; now?: () => number }) {
    this.maxSessions = options.maxSessions;
    this.idleTtlMs = options.idleTtlMs;
    this.pressureIdleTtlMs = options.pressureIdleTtlMs;
    this.pressureSoftTarget = options.pressureSoftTarget ?? Math.max(1, Math.floor(options.maxSessions * 0.8));
    this.now = options.now ?? Date.now;
    if (this.pressureIdleTtlMs !== undefined && this.pressureIdleTtlMs > this.idleTtlMs) {
      throw new Error("pressureIdleTtlMs must not exceed idleTtlMs.");
    }
    if (!Number.isInteger(this.pressureSoftTarget) || this.pressureSoftTarget < 1 || this.pressureSoftTarget > this.maxSessions) {
      throw new Error("pressureSoftTarget must be an integer from 1 to maxSessions.");
    }
  }

  get size(): number { return this.sessions.size; }

  stats() {
    const now = this.now();
    const entries = [...this.sessions.values()];
    const idle = entries.filter((entry) => entry.inFlight === 0);
    const pressureDeadline = this.pressureIdleTtlMs === undefined ? undefined : now - this.pressureIdleTtlMs;
    return {
      active: entries.length,
      reservations: this.reservations,
      in_flight: entries.reduce((sum, entry) => sum + entry.inFlight, 0),
      reclaimable_under_pressure: pressureDeadline === undefined ? 0 : idle.filter((entry) => entry.lastAccessedAt <= pressureDeadline).length,
      oldest_idle_ms: idle.length === 0 ? null : Math.max(...idle.map((entry) => Math.max(0, now - entry.lastAccessedAt))),
      cumulative: {
        committed: this.committed,
        normal_expired: this.normalExpired,
        pressure_reclaimed: this.pressureReclaimed,
        admission_rejected: this.admissionRejected
      }
    };
  }

  async reserve(): Promise<SessionReservation<T> | undefined> {
    await this.sweepExpired();
    if (this.pressureIdleTtlMs !== undefined && this.occupancy() + 1 > this.pressureSoftTarget) {
      await this.reclaimUnderPressure(Math.max(0, this.pressureSoftTarget - 1));
    }
    if (this.occupancy() >= this.maxSessions) {
      this.admissionRejected += 1;
      return undefined;
    }
    this.reservations += 1;
    let active = true;
    const release = (): void => { if (!active) return; active = false; this.reservations -= 1; };
    return {
      commit: (sessionId, transport) => {
        if (!active) throw new Error("Session reservation is no longer active.");
        release();
        this.sessions.set(sessionId, { transport, lastAccessedAt: this.now(), inFlight: 0 });
        this.committed += 1;
      },
      release
    };
  }

  get(sessionId: string): T | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    entry.lastAccessedAt = this.now();
    return entry.transport;
  }

  acquire(sessionId: string): SessionLease<T> | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    entry.lastAccessedAt = this.now();
    entry.inFlight += 1;
    let active = true;
    return { transport: entry.transport, release: () => {
      if (!active) return;
      active = false;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.lastAccessedAt = this.now();
    } };
  }

  remove(sessionId: string): boolean { return this.sessions.delete(sessionId); }

  async sweepExpired(): Promise<{ expired: number; close_failures: number }> {
    const deadline = this.now() - this.idleTtlMs;
    const expired = [...this.sessions.entries()].filter(([, entry]) => entry.inFlight === 0 && entry.lastAccessedAt <= deadline);
    for (const [sessionId] of expired) this.sessions.delete(sessionId);
    this.normalExpired += expired.length;
    return { expired: expired.length, close_failures: await closeTransports(expired.map(([, entry]) => entry.transport)) };
  }

  async sweepPressure(): Promise<{ reclaimed: number; close_failures: number }> {
    if (this.pressureIdleTtlMs === undefined) return { reclaimed: 0, close_failures: 0 };
    return this.reclaimUnderPressure(this.pressureSoftTarget);
  }

  async close(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.sessions.delete(sessionId);
    await entry.transport.close();
    return true;
  }

  async closeAll(): Promise<{ closed: number; close_failures: number }> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    this.reservations = 0;
    return { closed: entries.length, close_failures: await closeTransports(entries.map((entry) => entry.transport)) };
  }

  private occupancy(): number { return this.sessions.size + this.reservations; }

  private async reclaimUnderPressure(targetOccupancy: number): Promise<{ reclaimed: number; close_failures: number }> {
    if (this.pressureIdleTtlMs === undefined) return { reclaimed: 0, close_failures: 0 };
    const needed = this.occupancy() - targetOccupancy;
    if (needed <= 0) return { reclaimed: 0, close_failures: 0 };
    const deadline = this.now() - this.pressureIdleTtlMs;
    const candidates = [...this.sessions.entries()]
      .filter(([, entry]) => entry.inFlight === 0 && entry.lastAccessedAt <= deadline)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)
      .slice(0, needed);
    for (const [sessionId] of candidates) this.sessions.delete(sessionId);
    this.pressureReclaimed += candidates.length;
    return { reclaimed: candidates.length, close_failures: await closeTransports(candidates.map(([, entry]) => entry.transport)) };
  }
}

async function closeTransports<T extends ClosableTransport>(transports: T[]): Promise<number> {
  const results = await Promise.allSettled(transports.map((transport) => transport.close()));
  return results.filter((result) => result.status === "rejected").length;
}
