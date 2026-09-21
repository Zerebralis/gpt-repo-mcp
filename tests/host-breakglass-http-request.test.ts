import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processExecMock = vi.hoisted(() => ({
  runProcessWithTail: vi.fn()
}));
vi.mock("../src/services/process-exec.js", () => processExecMock);

import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import {
  buildWindowsUserEnvQueryArgs,
  hostHttpRequest,
  parseWindowsUserEnvValue,
  resolveConfiguredCredential
} from "../src/host-breakglass/http-request.js";

const ENV_NAME = "BREAKGLASS_TEST_HTTP_TOKEN";
const TEST_VALUE = "fixture-credential-value";
const PROCESS_ENV_VALUE = "process-env-must-not-be-used";
const ORIGINAL_SYSTEM_ROOT = process.env.SystemRoot;
const ORIGINAL_TEST_ENV = process.env[ENV_NAME];

function registryResult(value = TEST_VALUE, overrides: Record<string, unknown> = {}) {
  return {
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
    stdout_tail: "\r\n    " + ENV_NAME + "    REG_SZ    " + value + "\r\n",
    stderr_tail: "",
    stdout_truncated: false,
    stderr_truncated: false,
    ...overrides
  };
}

function context(options: {
  allowed_hosts?: string[];
  max_request_body_bytes?: number;
  max_response_body_bytes?: number;
  max_redirects?: number;
} = {}) {
  return createHostBreakglassContext(HostBreakglassConfigSchema.parse({
    enabled: true,
    mode: "safe",
    roots: [{ id: "test", root: process.cwd(), read: true, write: false, execute: false }],
    http: {
      credentials: [{
        id: "test-api",
        source: "windows_user_env",
        name: ENV_NAME,
        scheme: "bearer",
        allowed_hosts: options.allowed_hosts ?? ["api.example.test"]
      }],
      max_request_body_bytes: options.max_request_body_bytes ?? 1024,
      max_response_body_bytes: options.max_response_body_bytes ?? 1024,
      max_redirects: options.max_redirects ?? 2
    }
  }));
}

beforeEach(() => {
  process.env.SystemRoot = ORIGINAL_SYSTEM_ROOT ?? "C:\\Windows";
  process.env[ENV_NAME] = PROCESS_ENV_VALUE;
  processExecMock.runProcessWithTail.mockReset();
  processExecMock.runProcessWithTail.mockResolvedValue(registryResult());
});

afterEach(() => {
  if (ORIGINAL_SYSTEM_ROOT === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = ORIGINAL_SYSTEM_ROOT;
  if (ORIGINAL_TEST_ENV === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = ORIGINAL_TEST_ENV;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credentialed Host Breakglass HTTP", () => {
  it("resolves a configured reference without placing the value in process arguments", async () => {
    expect(buildWindowsUserEnvQueryArgs(ENV_NAME)).toEqual(["query", "HKCU\\Environment", "/v", ENV_NAME]);
    expect(buildWindowsUserEnvQueryArgs(ENV_NAME).join(" ")).not.toContain(TEST_VALUE);
    expect(parseWindowsUserEnvValue(
      "\r\n    " + ENV_NAME + "    REG_SZ    " + TEST_VALUE + "\r\n",
      ENV_NAME
    )).toBe(TEST_VALUE);

    const resolved = await resolveConfiguredCredential(context(), "test-api");
    expect(resolved.binding.name).toBe(ENV_NAME);
    expect(resolved.secret).toBe(TEST_VALUE);
    expect(resolved.secret).not.toBe(PROCESS_ENV_VALUE);
    expect(processExecMock.runProcessWithTail).toHaveBeenCalledTimes(1);
    const processInput = processExecMock.runProcessWithTail.mock.calls[0]?.[0];
    expect(processInput.executable).toMatch(/[\\/]System32[\\/]reg\.exe$/i);
    expect(processInput.args).toEqual(buildWindowsUserEnvQueryArgs(ENV_NAME));
    expect(JSON.stringify(processInput)).not.toContain(TEST_VALUE);
    expect(JSON.stringify(processInput)).not.toContain(PROCESS_ENV_VALUE);
  });

  it("injects the configured credential host-side and redacts an echoed value", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer " + TEST_VALUE);
      expect(init?.body).toBe(JSON.stringify({ model: "unit-test", max_tokens: 8 }));
      return new Response(JSON.stringify({ ok: true, reflected: TEST_VALUE }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": TEST_VALUE }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await hostHttpRequest(context(), {
      method: "POST",
      url: "https://api.example.test/v1/chat",
      credential_ref: "test-api",
      headers: { "content-type": "application/json" },
      body: { model: "unit-test", max_tokens: 8 }
    });

    expect(result.status).toBe(200);
    expect(result.body).not.toContain(TEST_VALUE);
    expect(result.body).toContain("[REDACTED]");
    expect(result.headers["x-request-id"]).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(TEST_VALUE);
  });

  it("validates URL policy before reading the configured value", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(hostHttpRequest(context(), {
      url: "https://other.example.test/v1",
      credential_ref: "test-api"
    })).rejects.toThrow(/not authorized/i);
    expect(processExecMock.runProcessWithTail).not.toHaveBeenCalled();
  });

  it("rejects plaintext HTTP, non-default ports, credentials in URLs, and secret-like query parameters", async () => {
    const requests = [
      "http://api.example.test/v1",
      "https://api.example.test:8443/v1",
      "https://user:pass@api.example.test/v1",
      "https://api.example.test/v1?api_key=caller-value"
    ];

    for (const url of requests) {
      await expect(hostHttpRequest(context(), { url, credential_ref: "test-api" })).rejects.toThrow();
    }
  });

  it("rejects caller-supplied sensitive headers and request-body secret fields", async () => {
    await expect(hostHttpRequest(context(), {
      method: "POST",
      url: "https://api.example.test/v1",
      credential_ref: "test-api",
      headers: { Authorization: "caller-value" },
      body: { model: "unit-test" }
    })).rejects.toThrow(/headers/i);

    await expect(hostHttpRequest(context(), {
      method: "POST",
      url: "https://api.example.test/v1",
      credential_ref: "test-api",
      body: { model: "unit-test", api_key: "caller-value" }
    })).rejects.toThrow(/request body fields/i);
  });

  it("fails closed for unknown and unavailable credential references", async () => {
    await expect(hostHttpRequest(context(), {
      url: "https://api.example.test/v1",
      credential_ref: "missing"
    })).rejects.toThrow(/unknown credential reference/i);
    expect(processExecMock.runProcessWithTail).not.toHaveBeenCalled();

    processExecMock.runProcessWithTail.mockResolvedValueOnce(registryResult("", { exit_code: 1 }));
    await expect(hostHttpRequest(context(), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api"
    })).rejects.toThrow(/unavailable/i);
  });

  it("follows same-origin redirects and refuses cross-origin redirects", async () => {
    const sameOriginFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/v2" } }))
      .mockResolvedValueOnce(new Response("done", { status: 200 }));
    vi.stubGlobal("fetch", sameOriginFetch);

    const same = await hostHttpRequest(context(), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api"
    });
    expect(same.status).toBe(200);
    expect(same.redirects_followed).toBe(1);
    expect(sameOriginFetch).toHaveBeenCalledTimes(2);

    const crossOriginFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://evil.example/v2" } }));
    vi.stubGlobal("fetch", crossOriginFetch);

    await expect(hostHttpRequest(context(), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api"
    })).rejects.toThrow(/cross-origin/i);
    expect(crossOriginFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses reflected credentials in redirect targets and enforces the redirect limit", async () => {
    const reflectedFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "/next?echo=" + encodeURIComponent(TEST_VALUE) }
      })
    );
    vi.stubGlobal("fetch", reflectedFetch);

    await expect(hostHttpRequest(context(), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api"
    })).rejects.toThrow(/reflected the configured credential/i);
    expect(reflectedFetch).toHaveBeenCalledTimes(1);

    const limitedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/v2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/v3" } }));
    vi.stubGlobal("fetch", limitedFetch);

    await expect(hostHttpRequest(context({ max_redirects: 1 }), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api"
    })).rejects.toThrow(/redirect limit exceeded/i);
    expect(limitedFetch).toHaveBeenCalledTimes(2);
  });

  it("sanitizes credential header-construction failures", async () => {
    processExecMock.runProcessWithTail.mockResolvedValueOnce(registryResult(TEST_VALUE + "\u0100"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let message = "";
    try {
      await hostHttpRequest(context(), {
        url: "https://api.example.test/v1",
        credential_ref: "test-api"
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Configured credential could not be applied safely.");
    expect(message).not.toContain(TEST_VALUE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses redirects that would rewrite a non-GET request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "/other" } })
    ));

    await expect(hostHttpRequest(context(), {
      method: "POST",
      url: "https://api.example.test/v1",
      credential_ref: "test-api",
      body: { model: "unit-test" }
    })).rejects.toThrow(/rewrite/i);
  });

  it("bounds oversized response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("x".repeat(4096), { status: 200, headers: { "content-type": "text/plain" } })
    ));

    const result = await hostHttpRequest(context({ max_response_body_bytes: 64 }), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api",
      max_body_bytes: 64
    });

    expect(Buffer.byteLength(result.body, "utf8")).toBe(64);
    expect(result.body_truncated).toBe(true);
  });

  it("returns generic transport and timeout errors without reflecting underlying error text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failed " + TEST_VALUE)));
    await expect(hostHttpRequest(context(), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api"
    })).rejects.toThrow("Credentialed HTTPS request failed before a response was received.");

    const timeout = new Error("timeout " + TEST_VALUE);
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    await expect(hostHttpRequest(context(), {
      url: "https://api.example.test/v1",
      credential_ref: "test-api"
    })).rejects.toThrow("Credentialed HTTPS request timed out.");
  });

  it("rejects oversized request bodies before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(hostHttpRequest(context({ max_request_body_bytes: 16 }), {
      method: "POST",
      url: "https://api.example.test/v1",
      credential_ref: "test-api",
      body: { payload: "x".repeat(100) }
    })).rejects.toThrow(/request body exceeds/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
