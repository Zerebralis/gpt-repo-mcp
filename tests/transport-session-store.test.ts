import { describe, expect, test } from "vitest";
import { TransportSessionStore } from "../src/runtime/transport-session-store.js";

class TestTransport {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const emptyMissCounters = {
  pressure_reclaim_reuse_attempts: 0,
  normal_expiry_reuse_attempts: 0,
  unknown_session_misses: 0
};

describe("TransportSessionStore", () => {
  test("bounds committed sessions and outstanding reservations", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 2, idleTtlMs: 60_000 });
    const first = await store.reserve();
    const second = await store.reserve();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(await store.reserve()).toBeUndefined();

    first?.commit("__proto__", new TestTransport());
    second?.commit("second", new TestTransport());
    expect(store.size).toBe(2);
    expect(store.get("__proto__")).toBeInstanceOf(TestTransport);
    expect(store.stats().cumulative).toEqual({
      committed: 2,
      normal_expired: 0,
      pressure_reclaimed: 0,
      admission_rejected: 1,
      ...emptyMissCounters
    });
  });

  test("releasing a reservation returns its capacity", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 1, idleTtlMs: 60_000 });
    const reservation = await store.reserve();
    reservation?.release();

    expect(await store.reserve()).toBeDefined();
  });

  test("expires idle sessions and records reuse after normal expiry", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 2,
      idleTtlMs: 100,
      now: () => now
    });
    const idle = new TestTransport();
    const active = new TestTransport();
    (await store.reserve())?.commit("idle", idle);
    (await store.reserve())?.commit("active", active);

    now = 1_080;
    expect(store.get("active")).toBe(active);
    now = 1_150;
    const result = await store.sweepExpired();

    expect(result).toEqual({ expired: 1, close_failures: 0 });
    expect(store.get("idle")).toBeUndefined();
    expect(store.get("active")).toBe(active);
    expect(idle.closeCalls).toBe(1);
    expect(active.closeCalls).toBe(0);
    expect(store.stats().cumulative).toMatchObject({
      normal_expired: 1,
      normal_expiry_reuse_attempts: 1
    });
  });

  test("close removes one session and closes its transport exactly once", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 1, idleTtlMs: 60_000 });
    const transport = new TestTransport();
    (await store.reserve())?.commit("session", transport);

    await expect(store.close("session")).resolves.toBe(true);
    await expect(store.close("session")).resolves.toBe(false);
    expect(store.get("session")).toBeUndefined();
    expect(transport.closeCalls).toBe(1);
    expect(store.stats().cumulative.unknown_session_misses).toBe(1);
  });

  test("closeAll releases every transport during shutdown", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 2, idleTtlMs: 60_000 });
    const first = new TestTransport();
    const second = new TestTransport();
    (await store.reserve())?.commit("first", first);
    (await store.reserve())?.commit("second", second);

    await expect(store.closeAll()).resolves.toEqual({ closed: 2, close_failures: 0 });
    expect(store.size).toBe(0);
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
  });

  test("does not pressure-sweep at or below the high watermark", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 10,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      pressureSoftTarget: 8,
      pressureHighWatermark: 9,
      now: () => now
    });
    const transports = Array.from({ length: 9 }, () => new TestTransport());
    for (const [index, transport] of transports.entries()) {
      (await store.reserve())?.commit(`session-${index}`, transport);
    }

    now = 1_500;
    await expect(store.sweepPressure()).resolves.toEqual({ reclaimed: 0, close_failures: 0 });
    expect(store.size).toBe(9);
    expect(transports.every((transport) => transport.closeCalls === 0)).toBe(true);
  });

  test("uses hysteresis when an admission would cross the pressure high watermark", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 10,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      pressureSoftTarget: 8,
      pressureHighWatermark: 9,
      now: () => now
    });
    const transports = Array.from({ length: 9 }, () => new TestTransport());
    for (const [index, transport] of transports.entries()) {
      (await store.reserve())?.commit(`old-${index}`, transport);
    }

    now = 1_101;
    const replacement = await store.reserve();
    expect(replacement).toBeDefined();
    expect(store.size).toBe(7);
    expect(transports.filter((transport) => transport.closeCalls === 1)).toHaveLength(2);
    replacement?.commit("replacement", new TestTransport());
    expect(store.size).toBe(8);
    expect(store.stats().cumulative).toMatchObject({
      committed: 10,
      pressure_reclaimed: 2,
      admission_rejected: 0
    });
  });

  test("periodic pressure sweep acts only above the high watermark and returns to the soft target", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 10,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      pressureSoftTarget: 8,
      pressureHighWatermark: 9,
      now: () => now
    });
    const transports = Array.from({ length: 10 }, () => new TestTransport());
    for (const [index, transport] of transports.entries()) {
      (await store.reserve())?.commit(`fresh-${index}`, transport);
    }
    expect(store.size).toBe(10);

    now = 1_101;
    await expect(store.sweepPressure()).resolves.toEqual({ reclaimed: 2, close_failures: 0 });
    expect(store.size).toBe(8);
    expect(transports.filter((transport) => transport.closeCalls === 1)).toHaveLength(2);
  });

  test("protects idle sessions younger than the pressure idle threshold even at the hard cap", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 4,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 800,
      pressureSoftTarget: 3,
      pressureHighWatermark: 3,
      now: () => now
    });
    const transports = Array.from({ length: 4 }, () => new TestTransport());
    for (const [index, transport] of transports.entries()) {
      (await store.reserve())?.commit(`protected-${index}`, transport);
    }

    now = 1_700;
    expect(await store.reserve()).toBeUndefined();
    expect(store.size).toBe(4);
    expect(transports.every((transport) => transport.closeCalls === 0)).toBe(true);
    expect(store.stats().cumulative.admission_rejected).toBe(1);
  });

  test("records a client reuse attempt after pressure reclamation", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 5,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      pressureSoftTarget: 3,
      pressureHighWatermark: 4,
      now: () => now
    });
    for (let index = 0; index < 5; index += 1) {
      (await store.reserve())?.commit(`session-${index}`, new TestTransport());
    }

    now = 1_101;
    await store.sweepPressure();
    expect(store.size).toBe(3);

    const missing = Array.from({ length: 5 }, (_, index) => store.get(`session-${index}`))
      .filter((transport) => transport === undefined);
    expect(missing).toHaveLength(2);
    expect(store.stats().cumulative.pressure_reclaim_reuse_attempts).toBe(2);
  });

  test("records unknown session misses separately from known retirement reasons", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 2, idleTtlMs: 60_000 });
    expect(store.acquire("never-seen")).toBeUndefined();
    expect(store.stats().cumulative).toMatchObject({
      pressure_reclaim_reuse_attempts: 0,
      normal_expiry_reuse_attempts: 0,
      unknown_session_misses: 1
    });
  });

  test("never pressure-reclaims an in-flight session while creating headroom", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 5,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      pressureSoftTarget: 3,
      pressureHighWatermark: 4,
      now: () => now
    });
    const busy = new TestTransport();
    const idle = Array.from({ length: 4 }, () => new TestTransport());
    (await store.reserve())?.commit("busy", busy);
    for (const [index, transport] of idle.entries()) {
      (await store.reserve())?.commit(`idle-${index}`, transport);
    }
    const lease = store.acquire("busy");

    now = 1_101;
    await expect(store.sweepPressure()).resolves.toEqual({ reclaimed: 2, close_failures: 0 });
    expect(store.size).toBe(3);
    expect(busy.closeCalls).toBe(0);
    expect(idle.filter((transport) => transport.closeCalls === 1)).toHaveLength(2);
    lease?.release();
  });

  test("does not hard-expire an in-flight session", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 1,
      idleTtlMs: 100,
      pressureIdleTtlMs: 50,
      pressureSoftTarget: 1,
      pressureHighWatermark: 1,
      now: () => now
    });
    const busy = new TestTransport();
    (await store.reserve())?.commit("busy", busy);
    const lease = store.acquire("busy");
    now = 1_500;
    await expect(store.sweepExpired()).resolves.toEqual({ expired: 0, close_failures: 0 });
    await expect(store.sweepPressure()).resolves.toEqual({ reclaimed: 0, close_failures: 0 });
    lease?.release();
    now = 1_601;
    await expect(store.sweepExpired()).resolves.toEqual({ expired: 1, close_failures: 0 });
    expect(busy.closeCalls).toBe(1);
  });

  test("concurrent admissions do not over-reclaim or exceed capacity around the high watermark", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 10,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      pressureSoftTarget: 8,
      pressureHighWatermark: 9,
      now: () => now
    });
    const transports = Array.from({ length: 9 }, () => new TestTransport());
    for (const [index, transport] of transports.entries()) {
      (await store.reserve())?.commit(`base-${index}`, transport);
    }

    now = 1_101;
    const [first, second] = await Promise.all([store.reserve(), store.reserve()]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(transports.filter((transport) => transport.closeCalls === 1)).toHaveLength(2);

    first?.commit("parallel-a", new TestTransport());
    second?.commit("parallel-b", new TestTransport());
    expect(store.size).toBe(9);
    expect(store.stats().cumulative.pressure_reclaimed).toBe(2);
    expect(store.stats().cumulative.admission_rejected).toBe(0);
  });

  test("retirement provenance stays bounded while recent retirement reasons remain observable", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 1,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 1,
      pressureSoftTarget: 1,
      pressureHighWatermark: 1,
      now: () => now
    });
    (await store.reserve())?.commit("session-0", new TestTransport());

    for (let index = 1; index < 40; index += 1) {
      now += 2;
      const reservation = await store.reserve();
      expect(reservation).toBeDefined();
      reservation?.commit(`session-${index}`, new TestTransport());
    }

    expect(store.get("session-7")).toBeUndefined();
    expect(store.get("session-0")).toBeUndefined();
    expect(store.stats().cumulative).toMatchObject({
      pressure_reclaimed: 39,
      pressure_reclaim_reuse_attempts: 1,
      unknown_session_misses: 1
    });
  });

  test("generic pressure behavior remains admission-driven unless a lower high watermark is configured", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 5,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      now: () => now
    });
    const transports = Array.from({ length: 5 }, () => new TestTransport());
    for (const [index, transport] of transports.entries()) {
      (await store.reserve())?.commit(`default-${index}`, transport);
    }

    now = 1_101;
    await expect(store.sweepPressure()).resolves.toEqual({ reclaimed: 0, close_failures: 0 });
    const replacement = await store.reserve();
    expect(replacement).toBeDefined();
    expect(store.size).toBe(3);
    expect(transports.filter((transport) => transport.closeCalls === 1)).toHaveLength(2);
    replacement?.release();
  });

  test("rejects an invalid pressure high watermark below the soft target", () => {
    expect(() => new TransportSessionStore<TestTransport>({
      maxSessions: 10,
      idleTtlMs: 10_000,
      pressureIdleTtlMs: 100,
      pressureSoftTarget: 8,
      pressureHighWatermark: 7
    })).toThrow("pressureHighWatermark");
  });
});
