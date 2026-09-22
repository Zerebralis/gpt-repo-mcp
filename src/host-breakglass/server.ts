import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpRoutePatterns, isAuthorizedMcpPath } from "../runtime/mcp-routes.js";
import { isAllowedBrowserOrigin } from "../runtime/network-boundary.js";
import { TransportSessionStore, type SessionLease, type SessionReservation } from "../runtime/transport-session-store.js";
import { loadHostBreakglassConfig } from "./config.js";
import { createHostBreakglassContext } from "./context.js";
import { createHostBreakglassMcpServer } from "./register.js";
import { HOST_BREAKGLASS_TOOL_COUNT } from "./tools.js";

const port = readBoundedInteger("GPT_HOST_BREAKGLASS_PORT", 8797, 1, 65_535);
const host = resolveHost();
const configPath = resolve(process.env.GPT_HOST_BREAKGLASS_CONFIG ?? "config.host-breakglass.local.json");
const publicPathToken = process.env.GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN;
const maxSessions = readBoundedInteger("GPT_HOST_BREAKGLASS_MAX_SESSIONS", 100, 1, 250);
const sessionIdleTtlMs = readBoundedInteger("GPT_HOST_BREAKGLASS_SESSION_IDLE_TTL_MS", 10 * 60_000, 1_000, 24 * 60 * 60_000);
const sessionPressureIdleTtlMs = readBoundedInteger("GPT_HOST_BREAKGLASS_SESSION_PRESSURE_IDLE_TTL_MS", Math.min(60_000, sessionIdleTtlMs), 1_000, sessionIdleTtlMs);
const sessionSoftTarget = readBoundedInteger("GPT_HOST_BREAKGLASS_SESSION_SOFT_TARGET", Math.max(1, Math.floor(maxSessions * 0.8)), 1, maxSessions);
const sessionPressureHighWatermark = readBoundedInteger("GPT_HOST_BREAKGLASS_SESSION_PRESSURE_HIGH_WATERMARK", Math.max(sessionSoftTarget, Math.ceil(maxSessions * 0.9)), sessionSoftTarget, maxSessions);

if (!isLoopback(host) && !publicPathToken) {
  throw new Error("External host-breakglass bind requires GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN.");
}
if (publicPathToken && publicPathToken.length < 24) {
  throw new Error("GPT_HOST_BREAKGLASS_PUBLIC_PATH_TOKEN must be at least 24 characters.");
}

const config = await loadHostBreakglassConfig(configPath);
const context = createHostBreakglassContext(config);
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const requestHost = typeof req.headers.host === "string" ? req.headers.host : undefined;
  if (!isAllowedBrowserOrigin(origin, requestHost)) {
    res.status(403).send("Forbidden origin");
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));

const transports = new TransportSessionStore<StreamableHTTPServerTransport>({ maxSessions, idleTtlMs: sessionIdleTtlMs, pressureIdleTtlMs: sessionPressureIdleTtlMs, pressureSoftTarget: sessionSoftTarget, pressureHighWatermark: sessionPressureHighWatermark, emergencyReclaimAtCapacity: true });
const mcpRoutes = buildMcpRoutePatterns(publicPathToken);

app.get("/health", (_req, res) => {
  const stats = transports.stats();
  res.json({ ok: true, name: "gpt-repo-host-breakglass", mode: config.mode, full_host_access: config.full_host_access, tool_count: HOST_BREAKGLASS_TOOL_COUNT, computer_use: config.computer_use.enabled, mcp_sessions: { ...stats, capacity: maxSessions, soft_target: sessionSoftTarget, pressure_high_watermark: sessionPressureHighWatermark, idle_ttl_ms: sessionIdleTtlMs, pressure_idle_ttl_ms: sessionPressureIdleTtlMs } });
});

function authorized(req: Request, res: Response): boolean {
  if (isAuthorizedMcpPath(req.path, publicPathToken)) return true;
  res.status(404).send("Not found");
  return false;
}

app.post(mcpRoutes, async (req: Request, res: Response) => {
  if (!authorized(req, res)) return;
  const sessionId = req.headers["mcp-session-id"];
  let transport: StreamableHTTPServerTransport | undefined;
  let reservation: SessionReservation<StreamableHTTPServerTransport> | undefined;
  let lease: SessionLease<StreamableHTTPServerTransport> | undefined;
  try {
    if (typeof sessionId === "string") { lease = transports.acquire(sessionId); transport = lease?.transport; }
    if (!transport && !sessionId && isInitializeRequest(req.body)) {
      reservation = await transports.reserve();
      if (!reservation) {
        console.error(`host-breakglass MCP session capacity reached active=${transports.size} max=${maxSessions}`);
        res.status(503).json({ jsonrpc: "2.0", error: { code: -32001, message: "MCP session capacity reached" }, id: (req.body as { id?: unknown }).id ?? null });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (transport && reservation) {
            reservation.commit(newSessionId, transport);
            reservation = undefined;
          }
        }
      });
      transport.onclose = () => {
        const closedSessionId = transport?.sessionId;
        if (closedSessionId) transports.remove(closedSessionId);
      };
      await createHostBreakglassMcpServer(context).connect(transport);
    } else if (!transport) {
      if (typeof sessionId === "string") {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: (req.body as { id?: unknown }).id ?? null });
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: missing MCP session id" }, id: (req.body as { id?: unknown }).id ?? null });
      }
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (transport?.sessionId) await transports.close(transport.sessionId).catch(() => undefined);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  } finally {
    reservation?.release();
    lease?.release();
  }
});

app.get(mcpRoutes, async (req: Request, res: Response) => {
  if (!authorized(req, res)) return;
  const sessionId = req.headers["mcp-session-id"];
  const lease = typeof sessionId === "string" ? transports.acquire(sessionId) : undefined;
  const transport = lease?.transport;
  if (!transport) {
    if (typeof sessionId === "string") res.status(404).send("Session not found");
    else res.status(400).send("Missing MCP session id");
    return;
  }
  try {
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) res.status(500).send("Internal server error");
  } finally {
    lease?.release();
  }
});

app.delete(mcpRoutes, async (req: Request, res: Response) => {
  if (!authorized(req, res)) return;
  const sessionId = req.headers["mcp-session-id"];
  const lease = typeof sessionId === "string" ? transports.acquire(sessionId) : undefined;
  const transport = lease?.transport;
  if (!transport || typeof sessionId !== "string") {
    if (typeof sessionId === "string") res.status(404).send("Session not found");
    else res.status(400).send("Missing MCP session id");
    return;
  }
  try {
    await transport.handleRequest(req, res);
    await transports.close(sessionId);
  } catch {
    if (!res.headersSent) res.status(500).send("Internal server error");
  } finally {
    lease?.release();
  }
});

const cleanup = setInterval(() => {
  void (async () => {
    await transports.sweepExpired();
    await transports.sweepPressure();
  })();
}, Math.min(sessionPressureIdleTtlMs, 60_000));
cleanup.unref();
const httpServer = app.listen(port, host, () => {
  const path = publicPathToken ? "/t/[token]/mcp" : "/mcp";
  console.error(`gpt-repo-host-breakglass listening on http://${host}:${port}${path} mode=${config.mode}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanup);
  await transports.closeAll();
  await context.computerUse.close();
  await new Promise<void>((done) => httpServer.close(() => done()));
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

function resolveHost(): string {
  const requested = process.env.GPT_HOST_BREAKGLASS_HOST?.trim() || "127.0.0.1";
  if (!isLoopback(requested) && process.env.GPT_HOST_BREAKGLASS_ALLOW_EXTERNAL_BIND !== "true") {
    throw new Error("External host-breakglass bind is disabled. Keep loopback binding or set GPT_HOST_BREAKGLASS_ALLOW_EXTERNAL_BIND=true intentionally.");
  }
  return requested;
}
function isLoopback(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
