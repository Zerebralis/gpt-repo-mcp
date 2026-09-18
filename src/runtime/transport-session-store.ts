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

type RetiredSessionReason = "normal_expired" | "pressure_reclaimed" | "emergency_reclaimed";

export class TransportSessionStore<T extends ClosableTransport> {
  private readonly sessions = new Map<string, SessionEntry<T>>();
  private readonly retiredSessions = new Map<string, RetiredSessionReason>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly pressureIdleTtlMs?: number;
  private readonly pressureSoftTarget: number;
  private readonly pressureHighWatermark: number;
  private readonly emergencyReclaimAtCapacity: boolean;
  private readonly maxRetiredSessions: number;
  private readonly now: () => number;
  private reservations = 0;
  private committed = 0;
  private normalExpired = 0;
  private pressureReclaimed = 0;
  private emergencyReclaimed = 0;
  private admissionRejected = 0;
  private pressureReclaimReuseAttempts = 0;
  private emergencyReclaimReuseAttempts = 0;
  private normalExpiryReuseAttempts = 0;
  private unknownSessionMisses = 0;

  constructor(options: {
    maxSessions: number;
    idleTtlMs: number;
    pressureIdleTtlMs?: number;
    pressureSoftTarget?: number;
    pressureHighWatermark?: number;
    emergencyReclaimAtCapacity?: boolean;
    now?: () => number;
  }) {
    this.maxSessions = options.maxSessions;
    this.idleTtlMs = options.idleTtlMs;
    this.pressureIdleTtlMs = options.pressureIdleTtlMs;
    this.pressureSoftTarget = options.pressureSoftTarget ?? Math.max(1, Math.floor(options.maxSessions * 0.8));
    // Generic callers remain admission-driven unless they explicitly opt into proactive hysteresis.
    this.pressureHighWatermark = options.pressureHighWatermark ?? options.maxSessions;
    this.emergencyReclaimAtCapacity = options.emergencyReclaimAtCapacity ?? false;
    this.maxRetiredSessions = Math.max(32, options.maxSessions * 4);
    this.now = options.now ?? Date.now;
    if (this.pressureIdleTtlMs !== undefined && this.pressureIdleTtlMs > this.idleTtlMs) {
      throw new Error("pressureIdleTtlMs must not exceed idleTtlMs.");
    }
    if (!Number.isInteger(this.pressureSoftTarget) || this.pressureSoftTarget < 1 || this.pressureSoftTarget > this.maxSessions) {
      throw new Error("pressureSoftTarget must be an integer from 1 to maxSessions.");
    }
    if (!Number.isInteger(this.pressureHighWatermark)
      || this.pressureHighWatermark < this.pressureSoftTarget
      || this.pressureHighWatermark > this.maxSessions) {
      throw new Error("pressureHighWatermark must be an integer from pressureSoftTarget to maxSessions.");
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
        emergency_reclaimed: this.emergencyReclaimed,
        admission_rejected: this.admissionRejected,
        pressure_reclaim_reuse_attempts: this.pressureReclaimReuseAttempts,
        emergency_reclaim_reuse_attempts: this.emergencyReclaimReuseAttempts,
        normal_expiry_reuse_attempts: this.normalExpiryReuseAttempts,
        unknown_session_misses: this.unknownSessionMisses
      }
    };
  }

  async reserve(): Promise<SessionReservation<T> | undefined> {
    await this.sweepExpired();
    if (this.pressureIdleTtlMs !== undefined && this.occupancy() + 1 > this.pressureHighWatermark) {
      await this.reclaimUnderPressure(Math.max(0, this.pressureSoftTarget - 1));
    }
    if (this.emergencyReclaimAtCapacity && this.occupancy() >= this.maxSessions) {
      await this.reclaimIdleAtCapacity(Math.max(0, this.pressureHighWatermark - 1));
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
        this.retiredSessions.delete(sessionId);
        this.sessions.set(sessionId, { transport, lastAccessedAt: this.now(), inFlight: 0 });
        this.committed += 1;
      },
      release
    };
  }

  get(sessionId: string): T | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.recordMissingSession(sessionId);
      return undefined;
    }
    entry.lastAccessedAt = this.now();
    return entry.transport;
  }

  acquire(sessionId: string): SessionLease<T> | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.recordMissingSession(sessionId);
      return undefined;
    }
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
    for (const [sessionId] of expired) {
      this.sessions.delete(sessionId);
      this.rememberRetiredSession(sessionId, "normal_expired");
    }
    this.normalExpired += expired.length;
    return { expired: expired.length, close_failures: await closeTransports(expired.map(([, entry]) => entry.transport)) };
  }

  async sweepPressure(): Promise<{ reclaimed: number; close_failures: number }> {
    if (this.pressureIdleTtlMs === undefined || this.occupancy() <= this.pressureHighWatermark) {
      return { reclaimed: 0, close_failures: 0 };
    }
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
    this.retiredSessions.clear();
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
    for (const [sessionId] of candidates) {
      this.sessions.delete(sessionId);
      this.rememberRetiredSession(sessionId, "pressure_reclaimed");
    }
    this.pressureReclaimed += candidates.length;
    return { reclaimed: candidates.length, close_failures: await closeTransports(candidates.map(([, entry]) => entry.transport)) };
  }

  private async reclaimIdleAtCapacity(targetOccupancy: number): Promise<{ reclaimed: number; close_failures: number }> {
    const needed = this.occupancy() - targetOccupancy;
    if (needed <= 0) return { reclaimed: 0, close_failures: 0 };
    const candidates = [...this.sessions.entries()]
      .filter(([, entry]) => entry.inFlight === 0)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)
      .slice(0, needed);
    for (const [sessionId] of candidates) {
      this.sessions.delete(sessionId);
      this.rememberRetiredSession(sessionId, "emergency_reclaimed");
    }
    this.emergencyReclaimed += candidates.length;
    return { reclaimed: candidates.length, close_failures: await closeTransports(candidates.map(([, entry]) => entry.transport)) };
  }

  private rememberRetiredSession(sessionId: string, reason: RetiredSessionReason): void {
    this.retiredSessions.delete(sessionId);
    this.retiredSessions.set(sessionId, reason);
    while (this.retiredSessions.size > this.maxRetiredSessions) {
      const oldest = this.retiredSessions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.retiredSessions.delete(oldest);
    }
  }

  private recordMissingSession(sessionId: string): void {
    const reason = this.retiredSessions.get(sessionId);
    if (reason === "pressure_reclaimed") this.pressureReclaimReuseAttempts += 1;
    else if (reason === "emergency_reclaimed") this.emergencyReclaimReuseAttempts += 1;
    else if (reason === "normal_expired") this.normalExpiryReuseAttempts += 1;
    else this.unknownSessionMisses += 1;
  }
}

async function closeTransports<T extends ClosableTransport>(transports: T[]): Promise<number> {
  const results = await Promise.allSettled(transports.map((transport) => transport.close()));
  return results.filter((result) => result.status === "rejected").length;
}
