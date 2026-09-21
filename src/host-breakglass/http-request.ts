import { win32 as windowsPath } from "node:path";
import { runProcessWithTail } from "../services/process-exec.js";
import type { HostBreakglassConfig } from "./config.js";
import type { HostBreakglassContext } from "./context.js";
import { minimalHostEnv } from "./shell-policy.js";

type HostHttpCredential = HostBreakglassConfig["http"]["credentials"][number];

export type HostHttpRequestInput = {
  method?: "GET" | "POST";
  url: string;
  credential_ref: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  timeout_ms?: number;
  max_body_bytes?: number;
};

const SENSITIVE_INPUT_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key)$/i;
const FORBIDDEN_TRANSPORT_HEADER = /^(host|connection|content-length|transfer-encoding|upgrade|te|trailer)$/i;
const SENSITIVE_FIELD_NAME = /^(authorization|proxy[_-]?authorization|api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|cookie)$/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "date",
  "server",
  "location",
  "retry-after",
  "request-id",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset"
] as const;

export function buildWindowsUserEnvQueryArgs(name: string): string[] {
  return ["query", "HKCU\\Environment", "/v", name];
}

export function parseWindowsUserEnvValue(output: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^\\s*" + escaped + "\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$", "i");
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = match[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

export async function resolveConfiguredCredential(
  context: HostBreakglassContext,
  credentialRef: string
): Promise<{ binding: HostHttpCredential; secret: string }> {
  const binding = context.config.http.credentials.find((entry) => entry.id === credentialRef);
  if (!binding) throw new Error("Unknown credential reference.");

  if (binding.source !== "windows_user_env") {
    throw new Error("Configured credential is unavailable.");
  }

  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) throw new Error("Configured credential is unavailable.");

  const result = await runProcessWithTail({
    executable: windowsPath.join(systemRoot, "System32", "reg.exe"),
    args: buildWindowsUserEnvQueryArgs(binding.name),
    cwd: systemRoot,
    env: minimalHostEnv(),
    timeout_ms: 5_000,
    tail_bytes: 16 * 1024
  });

  if (result.timed_out || result.exit_code !== 0) {
    throw new Error("Configured credential is unavailable.");
  }

  const value = parseWindowsUserEnvValue(result.stdout_tail, binding.name);
  if (!value) throw new Error("Configured credential is unavailable.");
  return { binding, secret: value };
}

export async function hostHttpRequest(
  context: HostBreakglassContext,
  input: HostHttpRequestInput
) {
  const binding = context.config.http.credentials.find((entry) => entry.id === input.credential_ref);
  if (!binding) throw new Error("Unknown credential reference.");
  const method = input.method ?? "GET";
  const initialUrl = new URL(input.url);
  assertCredentialedUrlAllowed(binding, initialUrl);
  const { secret } = await resolveConfiguredCredential(context, input.credential_ref);

  if (method === "GET" && input.body !== undefined) {
    throw new Error("GET requests must not include a request body.");
  }

  const requestHeaders = buildRequestHeaders(input.headers ?? {}, binding, secret);
  let requestBody: string | undefined;
  if (input.body !== undefined) {
    assertNoSensitiveFields(input.body);
    requestBody = JSON.stringify(input.body);
    if (requestBody === undefined) throw new Error("Request body must be JSON serializable.");
    const bodyBytes = Buffer.byteLength(requestBody, "utf8");
    if (bodyBytes > context.config.http.max_request_body_bytes) {
      throw new Error("Request body exceeds the configured credentialed HTTP limit.");
    }
    if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
  }

  const timeoutMs = Math.min(
    Math.max(1, input.timeout_ms ?? 30_000),
    context.config.limits.max_timeout_ms,
    60_000
  );
  const maxBodyBytes = Math.min(
    Math.max(0, input.max_body_bytes ?? 64 * 1024),
    context.config.http.max_response_body_bytes,
    1024 * 1024
  );
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();

  let currentUrl = initialUrl;
  let redirectsFollowed = 0;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Credentialed HTTPS request timed out.");

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method,
        headers: requestHeaders,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(remaining)
      });
    } catch (error) {
      if (isTimeoutError(error)) throw new Error("Credentialed HTTPS request timed out.");
      throw new Error("Credentialed HTTPS request failed before a response was received.");
    }

    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return buildResponseResult(response, currentUrl, method, started, redirectsFollowed, maxBodyBytes, secret);
      }
      if (redirectsFollowed >= context.config.http.max_redirects) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Credentialed HTTPS redirect limit exceeded.");
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Credentialed HTTPS redirect target is invalid.");
      }
      if (containsSecret(nextUrl.toString(), secret)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Credentialed HTTPS redirect reflected the configured credential.");
      }
      if (nextUrl.origin !== currentUrl.origin) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Credentialed HTTPS cross-origin redirects are not allowed.");
      }
      assertCredentialedUrlAllowed(binding, nextUrl);

      if (method !== "GET" && ![307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Credentialed HTTPS redirect would rewrite a non-GET request.");
      }

      await response.body?.cancel().catch(() => undefined);
      currentUrl = nextUrl;
      redirectsFollowed += 1;
      continue;
    }

    return buildResponseResult(response, currentUrl, method, started, redirectsFollowed, maxBodyBytes, secret);
  }
}

function assertCredentialedUrlAllowed(binding: HostHttpCredential, url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Credentialed HTTP requires a credential-free https:// URL.");
  }
  if (url.hash) throw new Error("Credentialed HTTP URLs must not contain fragments.");
  if (url.port && url.port !== "443") throw new Error("Credentialed HTTP only permits the default HTTPS port.");

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = binding.allowed_hosts.some((entry) => entry.toLowerCase().replace(/\.$/, "") === hostname);
  if (!allowed) throw new Error("Credential reference is not authorized for this HTTPS host.");

  for (const [name] of url.searchParams) {
    if (SENSITIVE_FIELD_NAME.test(name)) {
      throw new Error("Credentialed HTTP rejects secret-like query parameters; use a configured credential reference instead.");
    }
  }
}

function buildRequestHeaders(
  inputHeaders: Record<string, string>,
  binding: HostHttpCredential,
  secret: string
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(inputHeaders)) {
    if (SENSITIVE_INPUT_HEADER.test(name) || FORBIDDEN_TRANSPORT_HEADER.test(name)) {
      throw new Error("Credentialed HTTP rejects caller-supplied sensitive or transport-controlled headers.");
    }
    headers.set(name, value);
  }

  try {
    switch (binding.scheme) {
      case "bearer":
        headers.set("authorization", "Bearer " + secret);
        break;
      case "x-api-key":
        headers.set("x-api-key", secret);
        break;
      case "x-goog-api-key":
        headers.set("x-goog-api-key", secret);
        break;
    }
  } catch {
    throw new Error("Configured credential could not be applied safely.");
  }
  return headers;
}

function assertNoSensitiveFields(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("Request body must not contain circular references.");
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveFields(entry, seen);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_NAME.test(key)) {
      throw new Error("Credentialed HTTP rejects secret-like request body fields; use a configured credential reference instead.");
    }
    assertNoSensitiveFields(child, seen);
  }
}

async function buildResponseResult(
  response: Response,
  url: URL,
  method: "GET" | "POST",
  started: number,
  redirectsFollowed: number,
  maxBodyBytes: number,
  secret: string
) {
  let body = "";
  let bodyTruncated = false;
  try {
    const bounded = await readBoundedBody(response, maxBodyBytes);
    body = redactSecret(bounded.body, secret);
    bodyTruncated = bounded.truncated;
  } catch {
    throw new Error("Credentialed HTTPS response body could not be read safely.");
  }

  const headers: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = redactSecret(value, secret);
  }

  return {
    url: url.toString(),
    method,
    status: response.status,
    ok: response.ok,
    duration_ms: Date.now() - started,
    redirects_followed: redirectsFollowed,
    headers,
    body,
    body_truncated: bodyTruncated
  };
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (maxBodyBytes === 0 || !response.body) return { body: "", truncated: Boolean(response.body && maxBodyBytes === 0) };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let collected = 0;
  let truncated = false;
  try {
    while (collected <= maxBodyBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = maxBodyBytes + 1 - collected;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        collected += kept.length;
      }
      if (collected > maxBodyBytes || chunk.length > remaining) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks);
  truncated ||= buffer.length > maxBodyBytes;
  return { body: buffer.subarray(0, maxBodyBytes).toString("utf8"), truncated };
}

function containsSecret(value: string, secret: string): boolean {
  if (!value || !secret) return false;
  if (value.includes(secret)) return true;
  try {
    return value.includes(encodeURIComponent(secret));
  } catch {
    return false;
  }
}

function redactSecret(value: string, secret: string): string {
  if (!value || !secret) return value;
  let redacted = value;
  const variants = new Set([secret, encodeURIComponent(secret)]);
  for (const variant of variants) {
    if (variant) redacted = redacted.replaceAll(variant, "[REDACTED]");
  }
  return redacted;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}
