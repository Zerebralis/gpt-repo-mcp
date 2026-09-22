/* global AbortController */
import { describe, expect, it } from "vitest";
import {
  expectedHostPolicy,
  fingerprintHostConfiguration,
  waitForValidatedConfigurationChange
} from "../scripts/host-breakglass-config-watch.mjs";
import { hostHealthMatchesExpectedPolicy } from "../scripts/connect-host-breakglass-openai.mjs";

describe("Host Breakglass supervised config reconciliation", () => {
  it("fingerprints the effective env path/content and config path/content deterministically", () => {
    const base = {
      envPath: "C:\\state\\host.env",
      envRaw: "GPT_HOST_BREAKGLASS_CONFIG=C:\\Tools\\config.json\n",
      configPath: "C:\\Tools\\config.json",
      configRaw: "{\"enabled\":true,\"mode\":\"safe\"}"
    };
    const first = fingerprintHostConfiguration(base);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintHostConfiguration(base)).toBe(first);
    expect(fingerprintHostConfiguration({ ...base, configRaw: "{\"enabled\":true,\"mode\":\"full\"}" })).not.toBe(first);
    expect(fingerprintHostConfiguration({ ...base, envRaw: base.envRaw + "# changed\n" })).not.toBe(first);
  });

  it("keeps the current runtime while replacement config is invalid, then reports a validated change", async () => {
    let calls = 0;
    let validations = 0;
    const blocked = [];
    let recovered = 0;
    const controller = new AbortController();
    const result = await waitForValidatedConfigurationChange({
      expectedFingerprint: "current",
      signal: controller.signal,
      pollMs: 1,
      settleMs: 1,
      readPreflight: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: "host-breakglass config missing or invalid" };
        if (calls === 2) return { ok: true, fingerprint: "current" };
        return { ok: true, fingerprint: "replacement", expectedPolicy: { mode: "full", full_host_access: true } };
      },
      validateCandidate: async (candidate) => {
        validations += 1;
        if (validations === 1) return { ok: false, reason: "host-breakglass config schema invalid" };
        return { ok: true, preflight: candidate };
      },
      onBlocked: async (reason) => blocked.push(reason),
      onRecovered: async () => { recovered += 1; }
    });

    expect(result).toMatchObject({
      changed: true,
      preflight: {
        fingerprint: "replacement",
        expectedPolicy: { mode: "full", full_host_access: true }
      }
    });
    expect(blocked).toEqual([
      "host-breakglass config missing or invalid",
      "host-breakglass config schema invalid"
    ]);
    expect(validations).toBe(2);
    expect(recovered).toBe(2);
  });

  it("validates the safe/full policy contract before a reload is accepted", () => {
    expect(expectedHostPolicy({})).toEqual({ mode: "full", full_host_access: true });
    expect(expectedHostPolicy({ mode: "safe" })).toEqual({ mode: "safe", full_host_access: false });
    expect(expectedHostPolicy({ mode: "full", full_host_access: true })).toEqual({ mode: "full", full_host_access: true });
    expect(() => expectedHostPolicy({ mode: "safe", full_host_access: true })).toThrow(/requires mode=full/i);
    expect(() => expectedHostPolicy({ mode: "unexpected", full_host_access: false })).toThrow(/invalid host breakglass mode/i);
  });

  it("accepts Core readiness only when the running policy matches the requested policy", () => {
    const full = { mode: "full", full_host_access: true };
    expect(hostHealthMatchesExpectedPolicy({ ok: true, mode: "full", full_host_access: true }, full)).toBe(true);
    expect(hostHealthMatchesExpectedPolicy({ ok: true, mode: "safe", full_host_access: false }, full)).toBe(false);
    expect(hostHealthMatchesExpectedPolicy({ ok: true, mode: "full" }, full)).toBe(false);
    expect(hostHealthMatchesExpectedPolicy({ ok: false, mode: "full", full_host_access: true }, full)).toBe(false);
  });
});
