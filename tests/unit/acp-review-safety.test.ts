import { beforeEach, describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent } from "../../src/agents/acp-agent.js";
import { CodexAgent } from "../../src/agents/codex-agent.js";

const mocks = vi.hoisted(() => ({ request: vi.fn(), handlers: new Map<any, any>(), close: vi.fn() }));
vi.mock("@agentclientprotocol/sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentclientprotocol/sdk")>();
  return { ...actual, ndJsonStream: vi.fn(), client: () => {
    const client = { onRequest: (method: any, handler: any) => { mocks.handlers.set(method, handler); return client; },
      onNotification: () => client, connect: () => ({ agent: { request: mocks.request }, close: mocks.close }) };
    return client;
  } };
});
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return { spawn: () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), killed: false, exitCode: null, kill: vi.fn() }) };
});

const confirmed = () => ({ configOptions: [{ id: "mode", type: "select", currentValue: "read-only", options: [] }] });
const agent = (reviewOnly = true) => new AcpAgent({ name: "codex", command: "synthetic-acp", args: [], reviewOnly });
beforeEach(() => {
  mocks.request.mockReset(); mocks.handlers.clear(); mocks.close.mockReset();
  mocks.request.mockImplementation(async (method: any) => {
    if (method === acp.methods.agent.session.new) return { sessionId: "session" };
    if (method === acp.methods.agent.session.setConfigOption) return confirmed();
    return { stopReason: "end_turn" };
  });
});
describe("ACP review safety (synthetic protocol, NOT provider E2E)", () => {
  it.each([[], [{ optionId: "allow" }], [{ optionId: "unknown" }], undefined])(
    "cancels permission requests regardless of available options", async options => {
      const a = agent(); await a.start();
      const handler = mocks.handlers.get(acp.methods.client.session.requestPermission);
      expect(await handler({ params: { options } })).toEqual({ outcome: { outcome: "cancelled" } });
      await a.close();
    });
  it("disables advertised writes and verifies mode before each prompt", async () => {
    const a = agent(); await a.initialize();
    expect(mocks.request).toHaveBeenCalledWith(acp.methods.agent.initialize, expect.objectContaining({
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    }));
    const session = await a.createSession("/synthetic");
    await a.prompt(session, "inspect only");
    const methods = mocks.request.mock.calls.map(call => call[0]);
    expect(methods.filter(method => method === acp.methods.agent.session.setConfigOption)).toHaveLength(2);
    expect(methods.at(-1)).toBe(acp.methods.agent.session.prompt);
    await a.close();
  });
  it.each([{}, { configOptions: [] }, { configOptions: [{ id: "mode", type: "select", currentValue: "agent" }] },
    { configOptions: [...confirmed().configOptions, ...confirmed().configOptions] }])(
    "rejects missing, writable or ambiguous mode confirmation before prompt", async result => {
      const a = agent(); await a.initialize();
      mocks.request.mockImplementation(async (method: any) => method === acp.methods.agent.session.new ? { sessionId: "session" } : result);
      await expect(a.createSession("/synthetic")).rejects.toThrow();
      await expect(a.prompt("session", "never send")).rejects.toThrow("READ_ONLY_SESSION_NOT_READY");
      expect(mocks.request.mock.calls.some(call => call[0] === acp.methods.agent.session.prompt)).toBe(false);
      await a.close();
    });
  it("rejects unsupported mode request, with no fallback session", async () => {
    const a = agent(); await a.initialize();
    mocks.request.mockImplementation(async (method: any) => {
      if (method === acp.methods.agent.session.new) return { sessionId: "session" };
      throw new Error("unsupported");
    });
    await expect(a.createSession("/synthetic")).rejects.toThrow("unsupported");
    await expect(a.prompt("session", "never send")).rejects.toThrow();
    expect(mocks.request.mock.calls.filter(call => call[0] === acp.methods.agent.session.new)).toHaveLength(1);
    await a.close();
  });
  it("blocks a turn after failed mode recheck and does not auto restart after close", async () => {
    const a = agent(); await a.initialize(); await a.createSession("/synthetic");
    mocks.request.mockRejectedValueOnce(new Error("mode lost"));
    await expect(a.prompt("session", "never send")).rejects.toThrow("mode lost");
    await expect(a.prompt("session", "never send")).rejects.toThrow("READ_ONLY_SESSION_NOT_READY");
    await a.close();
    await expect(a.prompt("session", "never send")).rejects.toThrow("READ_ONLY_SESSION_NOT_READY");
    expect(a.getRestartCount()).toBe(0);
    expect(mocks.request.mock.calls.some(call => call[0] === acp.methods.agent.session.prompt)).toBe(false);
  });
  it("preserves the legacy developer policy when reviewOnly is omitted", async () => {
    const a = agent(false); await a.initialize(); await a.createSession("/synthetic");
    const handler = mocks.handlers.get(acp.methods.client.session.requestPermission);
    expect(await handler({ params: { options: [{ optionId: "allow_once" }] } })).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(mocks.request.mock.calls.some(call => call[0] === acp.methods.agent.session.setConfigOption)).toBe(false);
    await a.close();
  });
  it("CodexAgent forwards the dedicated safety option", async () => {
    const a = new CodexAgent({ command: "synthetic-acp", args: [], reviewOnly: true });
    await a.initialize(); await a.createSession("/synthetic");
    expect(mocks.request.mock.calls.some(call => call[0] === acp.methods.agent.session.setConfigOption)).toBe(true);
    await a.close();
  });
});
