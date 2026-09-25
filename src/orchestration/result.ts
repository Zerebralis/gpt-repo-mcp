/** Caller-side interpretation only: this does not grant permission or change a tool policy. */
export const ERROR_CLASSES = [
  "UPSTREAM_AUTO_REVIEW", "BACKEND_POLICY", "LOCAL_EXEC_POLICY", "TRANSPORT",
  "ARGUMENT", "AUTH", "APPROVAL_PENDING", "EXPECTED_REVIEW_BLOCKED", "UNKNOWN"
] as const;
export type ErrorClass = typeof ERROR_CLASSES[number];
export type CheckedResult = { ok: boolean; value?: Record<string, unknown>; errorClass?: ErrorClass; retryable: boolean };
export const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export function classifyError(value: unknown): ErrorClass {
  const r = record(value), e = record(r?.error) ?? r;
  const code = e?.code;
  if (ERROR_CLASSES.includes(code as ErrorClass)) return code as ErrorClass;
  if (code === -32602 || code === "INVALID_ARGUMENT") return "ARGUMENT";
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "TRANSPORT_ERROR"].includes(String(code))) return "TRANSPORT";
  if (["UNAUTHORIZED", "FORBIDDEN"].includes(String(code))) return "AUTH";
  // Compatibility with the exact legacy error contracts observed in the audit.
  // Never scan arbitrary successful tool content (which can itself quote an error).
  if (code !== undefined && code !== "HOST_BREAKGLASS_ERROR") return "UNKNOWN";
  const message = typeof e?.message === "string" ? e.message : "";
  if (message.startsWith("Command blocked by host-breakglass safe policy")) return "BACKEND_POLICY";
  if (message.startsWith("This action was rejected due to unacceptable risk")) return "UPSTREAM_AUTO_REVIEW";
  if (message.startsWith("rejected: blocked by policy")) return "LOCAL_EXEC_POLICY";
  return "UNKNOWN";
}

export function checkResult(raw: unknown, required: string[] = [], expectedExitCodes = [0]): CheckedResult {
  const outer = record(raw);
  if (!outer) return { ok: false, errorClass: "UNKNOWN", retryable: false };
  let envelope = record(outer.structuredContent);
  if (!envelope && Array.isArray(outer.content)) {
    const texts = outer.content.filter(x => record(x)?.type === "text");
    const candidates: Record<string, unknown>[] = [];
    for (const text of texts) if (typeof text.text === "string") {
      try { const parsed=record(JSON.parse(text.text)); if(typeof parsed?.ok === "boolean")candidates.push(parsed); } catch { /* no success contract */ }
    }
    // Additional audit-warning blocks must not erase the known operation result.
    if(candidates.length===1)envelope=candidates[0];
    if(!envelope && outer.isError===true && texts.length===1) envelope={ok:false,error:{message:texts[0].text}};
  }
  envelope ??= outer;
  const value = record(envelope.result) ?? envelope;
  const failed = outer.isError === true || outer.ok === false || envelope.ok === false || value.ok === false || !!envelope.error || !!value.error ||
    (typeof value.failed === "number" && value.failed > 0) ||
    value.timed_out === true || value.status === "BLOCKED" ||
    ["failed", "killed", "timed_out"].includes(String(value.status)) ||
    (value.exit_code !== undefined && !expectedExitCodes.includes(value.exit_code as number)) ||
    required.some(key => value[key] === undefined || value[key] === null);
  // A fulfilled promise, empty object, or missing application contract is not success.
  const explicitSuccess = envelope.ok === true || value.ok === true;
  if (failed || !explicitSuccess) {
    const errorSource = record(value.error) ? value : record(envelope.error) ? envelope : outer;
    const errorClass = value.status === "BLOCKED" ? "EXPECTED_REVIEW_BLOCKED" : classifyError(errorSource);
    return { ok: false, value, errorClass, retryable: record(errorSource.error)?.retryable === true };
  }
  return { ok: true, value, retryable: false };
}
