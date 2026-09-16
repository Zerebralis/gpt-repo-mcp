import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { ComputerUseAdapter } from "../src/host-breakglass/computer-use-adapter.js";

const mocks = vi.hoisted(() => {
  const clients: Array<{
    connect: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onclose?: () => void;
  }> = [];
  const connect = vi.fn();
  return { clients, connect };
});
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "original" }] });
    listTools = vi.fn().mockResolvedValue({ tools: [{ name: "screenshot", inputSchema: { type: "object" } }] });
    close = vi.fn().mockResolvedValue(undefined);
    constructor() { mocks.clients.push(this); }
  }
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));

const adapter = () => new ComputerUseAdapter(HostBreakglassConfigSchema.parse({ computer_use: { enabled: true } }).computer_use);
beforeEach(() => { mocks.clients.length = 0; mocks.connect.mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());

describe("Computer-Use connection generations", () => {
  it("bounds the entire handshake and permits a later fresh attempt", async () => {
    vi.useFakeTimers();
    mocks.connect.mockImplementationOnce(() => new Promise(() => {}));
    const a = adapter();
    const result = a.call("screenshot", {});
    const rejected = expect(result).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(mocks.clients[0].callTool).not.toHaveBeenCalled();
    expect(mocks.clients[0].close).toHaveBeenCalledTimes(1);
    await a.call("screenshot", {});
    expect(mocks.clients).toHaveLength(2);
    await a.close();
  });

  it("shares one in-progress handshake between concurrent callers", async () => {
    const a = adapter();
    await Promise.all([a.catalog(), a.call("screenshot", {})]);
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await a.close();
  });

  it("discards a failed catalog connection and does not replay the request", async () => {
    const a = adapter();
    await a.catalog();
    const first = mocks.clients[0];
    first.listTools.mockRejectedValueOnce(new Error("offline"));
    await expect(a.catalog()).rejects.toThrow("offline");
    expect(first.listTools).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    await a.catalog();
    expect(mocks.clients).toHaveLength(2);
    await a.close();
  });

  it("does not let a late old-call failure close the replacement connection", async () => {
    const a = adapter();
    await a.catalog();
    const old = mocks.clients[0];
    let rejectOld!: (error: Error) => void;
    old.callTool.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const pending = a.call("screenshot", {});
    await Promise.resolve(); await Promise.resolve();
    old.onclose?.();
    await a.call("screenshot", {});
    const replacement = mocks.clients[1];
    rejectOld(new Error("old failure"));
    await expect(pending).rejects.toThrow("old failure");
    expect(replacement.close).not.toHaveBeenCalled();
    expect(old.callTool).toHaveBeenCalledTimes(1);
    await a.call("screenshot", {});
    expect(mocks.clients).toHaveLength(2);
    await a.close();
  });

  it("does not shorten a legitimate action or alter the successful response", async () => {
    vi.useFakeTimers();
    const a = adapter();
    await a.catalog();
    let resolveCall!: (result: unknown) => void;
    mocks.clients[0].callTool.mockImplementation(() => new Promise((resolve) => { resolveCall = resolve; }));
    const pending = a.call("screenshot", {});
    await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.clients[0].close).not.toHaveBeenCalled();
    const original = { content: [{ type: "image", data: "image", mimeType: "image/png" }], _meta: { original: true } };
    resolveCall(original);
    expect(await pending).toBe(original);
    expect(mocks.clients[0].callTool).toHaveBeenCalledExactlyOnceWith({ name: "screenshot", arguments: {} });
    await a.close();
  });

  it("fences a late successful handshake after close", async () => {
    let ready!: () => void;
    mocks.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve; }));
    const a = adapter();
    const pending = a.catalog();
    await a.close(); ready();
    await expect(pending).rejects.toThrow(/closed/);
    expect(mocks.clients[0].listTools).not.toHaveBeenCalled();
    await expect(a.catalog()).rejects.toThrow(/closed/);
    expect(mocks.clients).toHaveLength(1);
  });
});
