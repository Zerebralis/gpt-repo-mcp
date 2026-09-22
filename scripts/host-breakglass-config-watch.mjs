/* global setTimeout */
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

export async function waitForValidatedConfigurationChange({
  expectedFingerprint,
  readPreflight,
  signal,
  pollMs = 1000,
  onBlocked = async () => {},
  onRecovered = async () => {}
}) {
  let blockedReason;
  while (!signal?.aborted) {
    await delay(pollMs, signal);
    if (signal?.aborted) break;

    const next = await readPreflight();
    if (!next.ok) {
      if (next.reason !== blockedReason) {
        blockedReason = next.reason;
        await onBlocked(next.reason);
      }
      continue;
    }

    if (blockedReason !== undefined) {
      blockedReason = undefined;
      await onRecovered();
    }

    if (next.fingerprint !== expectedFingerprint) {
      return { changed: true, preflight: next };
    }
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
