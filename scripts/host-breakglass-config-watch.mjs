/* global setTimeout, clearTimeout */
import { createHash } from "node:crypto";

export function fingerprintHostConfiguration({ envPath, envRaw, configPath, configRaw }) {
  return createHash("sha256")
    .update(String(envPath))
    .update("\0")
    .update(String(envRaw))
    .update("\0")
    .update(String(configPath))
    .update("\0")
    .update(String(configRaw))
    .digest("hex");
}

export function expectedHostPolicy(config) {
  const mode = config?.mode ?? "full";
  const fullHostAccess = config?.full_host_access ?? (mode === "full");
  if (mode !== "safe" && mode !== "full") {
    throw new Error("Invalid Host Breakglass mode in config");
  }
  if (typeof fullHostAccess !== "boolean") {
    throw new Error("Invalid Host Breakglass full_host_access in config");
  }
  if (fullHostAccess && mode !== "full") {
    throw new Error("Host Breakglass full_host_access requires mode=full");
  }
  return { mode, full_host_access: fullHostAccess };
}

export async function waitForValidatedConfigurationChange({
  expectedFingerprint,
  readPreflight,
  validateCandidate = async (candidate) => ({ ok: true, preflight: candidate }),
  signal,
  pollMs = 1000,
  settleMs = 250,
  onBlocked = async () => {},
  onRecovered = async () => {}
}) {
  let blockedReason;

  async function block(reason) {
    if (reason !== blockedReason) {
      blockedReason = reason;
      await onBlocked(reason);
    }
  }
  async function recover() {
    if (blockedReason !== undefined) {
      blockedReason = undefined;
      await onRecovered();
    }
  }

  while (!signal?.aborted) {
    await delay(pollMs, signal);
    if (signal?.aborted) break;

    const next = await readPreflight();
    if (!next.ok) {
      await block(next.reason);
      continue;
    }

    if (next.fingerprint === expectedFingerprint) {
      await recover();
      continue;
    }

    await delay(settleMs, signal);
    if (signal?.aborted) break;
    const settled = await readPreflight();
    if (!settled.ok) {
      await block(settled.reason);
      continue;
    }
    if (settled.fingerprint !== next.fingerprint) continue;

    const validated = await validateCandidate(settled);
    if (!validated.ok) {
      await block(validated.reason);
      continue;
    }

    await recover();
    return { changed: true, preflight: validated.preflight ?? settled };
  }
  return { changed: false };
}

function delay(ms, signal) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener?.("abort", done);
      clearTimeout(timer);
      resolveDelay();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}
