# Host Breakglass Credentialed HTTPS

Status: implementation candidate

## Purpose

`host_http_request` is the structured path for bounded external HTTPS API
requests that need a locally configured credential. It exists so callers do not
need to combine environment reads, authorization construction, and network
requests inside `host_shell` or `host_process_start`.

`host_http_probe` remains a small diagnostic primitive for HEAD/GET health
checks. It does not resolve credentials and is not expanded into a general API
client.

## Trust boundary

The MCP caller supplies a credential reference, never a credential value.

A local configuration entry binds that reference to:

- one Windows user environment-variable name;
- one supported authentication scheme; and
- one or more exact allowed DNS hostnames.

Example configuration:

```json
{
  "http": {
    "credentials": [
      {
        "id": "groq",
        "source": "windows_user_env",
        "name": "GROQ_API_KEY",
        "scheme": "bearer",
        "allowed_hosts": ["api.groq.com"]
      },
      {
        "id": "nvidia",
        "source": "windows_user_env",
        "name": "NVIDIA_API_KEY",
        "scheme": "bearer",
        "allowed_hosts": ["integrate.api.nvidia.com"]
      }
    ]
  }
}
```

The configuration contains names and policy only. It must not contain the
credential values.

## Credential resolution

Resolution happens inside the Host Breakglass process.

1. The credential reference must exist in the configured allowlist.
2. The target URL is validated against the credential's exact host policy.
3. Only after the URL passes policy is the credential value resolved.
4. `windows_user_env` reads only the named `HKCU\\Environment` value at
   request time through the fixed `%SystemRoot%\\System32\\reg.exe` binary.
   A same-named inherited process-environment value is deliberately ignored.
5. Credentials added or changed in the Windows user environment after the
   Breakglass process started can therefore be used without copying them into
   MCP input or restarting solely to refresh inherited environment state.
6. The value is injected into the outbound request in memory.

The value is never placed in MCP arguments, process command lines, shell
history, audit metadata, repository files, documentation, or Git.

## Supported authentication schemes

- `bearer` -> outbound Authorization bearer header
- `x-api-key` -> outbound X-API-Key header
- `x-goog-api-key` -> outbound X-Goog-API-Key header

Callers cannot directly provide these sensitive headers.

## URL and host policy

Credentialed requests are fail-closed:

- HTTPS is mandatory.
- URL usernames/passwords are rejected.
- Non-default HTTPS ports are rejected.
- URL fragments are rejected.
- The DNS hostname must exactly match the credential's `allowed_hosts`.
- Wildcard host entries are not supported.
- Secret-like query parameter names are rejected.
- Full mode does not override a credential-to-host binding.

This is deliberately not a generic unrestricted HTTP proxy.

## Redirect policy

Redirects are handled manually.

- Only same-origin redirects are followed.
- Cross-origin redirects are rejected before another request is sent.
- Redirect count is bounded by configuration.
- GET redirects can be followed within the same origin.
- For POST, only 307/308 can preserve the request safely; redirect statuses
  that would rewrite the method are rejected.

A credential is therefore never forwarded automatically to a different origin.

## Request policy

The public tool contract supports bounded GET and POST operations.

The caller may supply normal API headers and JSON content such as:

- model
- messages
- max_tokens / max_completion_tokens
- reasoning_effort
- stream flags

The caller may not supply:

- authorization or proxy-authorization;
- cookies;
- supported API-key headers directly;
- transport-controlled headers such as Host or Content-Length;
- secret-like JSON field names such as api_key, token, password, or secret.

GET requests cannot contain a request body.

Request bodies are JSON serialized and size-bounded before the network request.

## Response policy

Responses expose bounded operational information:

- final same-origin URL;
- HTTP status and success flag;
- latency;
- redirect count;
- selected safe response headers;
- bounded response body;
- truncation state.

Only a small allowlist of response headers is returned. Authentication,
cookies, and arbitrary provider headers are not copied to the caller.

The exact resolved credential value and its URL-encoded representation are
redacted if a remote endpoint reflects them in an allowed response header or
response body.

Transport and timeout exceptions are converted to generic error messages so a
remote or platform error cannot reflect sensitive local detail.

## Audit policy

The normal Host Breakglass audit records only operation metadata. For
`host_http_request` that includes:

- action name;
- success/failure;
- duration; and
- target kind derived from the target hostname.

It does not record:

- credential values;
- environment-variable contents;
- request headers;
- request bodies;
- response bodies; or
- raw exception text.

## Bounds

Current hard limits:

- request timeout: at most 60 seconds and never above the global Breakglass
  timeout limit;
- request body: configured limit, hard maximum 4 MiB;
- response body: configured limit, hard maximum 4 MiB; the public tool input
  can request at most 1 MiB;
- redirects: configured limit, hard maximum 5.

Default configuration uses smaller limits.

## Operator guidance

Use `host_http_request` when an external API needs a credential already held
on the host and the destination is explicitly policy-approved.

Do not use it to:

- bypass external platform safety controls;
- discover arbitrary credential variables;
- send credentials to ad-hoc hosts;
- create a generic proxy;
- move credentials into temporary files;
- encode or obfuscate credentials to avoid checks.

If a platform outside this repository blocks an operation even when the
structured tool keeps the credential host-side, treat that as an external
boundary and document it rather than attempting to evade it.

## Verification

Automated tests cover:

- host-side reference resolution;
- outbound authentication injection;
- HTTPS and exact-host enforcement;
- caller-supplied sensitive header/body rejection;
- missing and unknown credential references;
- same-origin and cross-origin redirects;
- POST redirect method safety;
- response bounds and truncation;
- reflected-value redaction;
- sanitized transport and timeout errors; and
- MCP result and audit-record leak checks.

Live acceptance should additionally exercise locally configured provider
references without ever printing their values.
