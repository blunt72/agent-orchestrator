import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
import { collectOrcaWorker } from "../../src/integrations/orca-collector.js";

const executable = "/trusted/Orca.app/bin/orca";
const receipt = () => ({ ok: true, _meta: { runtimeId: "runtime-1" }, result: { dispatch: { id: "ctx_1" } } });
function reply(data: unknown, error: Error | null = null, stderr = "") {
  execute.mockImplementation((_file, _args, _options, callback) => {
    callback(error, Buffer.isBuffer(data) ? data : Buffer.from(typeof data === "string" ? data : JSON.stringify(data)), Buffer.from(stderr));
  });
}
beforeEach(() => { execute.mockReset(); reply(receipt()); });

describe("Orca collector synthetic subprocess tests (not real Orca/provider E2E)", () => {
  it("executes only fixed argv with bounded output, timeout and no shell", async () => {
    const result = await collectOrcaWorker(executable, "runtime-1", "ctx_1");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0].slice(0, 3)).toEqual([executable,
      ["orchestration", "worker-show", "--dispatch", "ctx_1", "--json"],
      { encoding: "buffer", shell: false, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 262144, windowsHide: true }]);
    expect(result).toMatchObject({ ok: true, receipt: receipt(), provenance: "LOCAL_CLI_OBSERVATION",
      bytes: Buffer.byteLength(JSON.stringify(receipt())) });
    if (result.ok) expect(result.stdoutSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["orca", "", "/bin/orca\n", "/bin/orca\0"])("rejects untrusted path shape %j before execution", async file => {
    expect(await collectOrcaWorker(file, "runtime-1", "ctx_1")).toEqual({ ok: false, code: "INVALID_CONFIG" });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["--help", "ctx_1;touch /tmp/no", "ctx 1", "", "x".repeat(129)])("rejects malformed identity %j", async id => {
    expect((await collectOrcaWorker(executable, "runtime-1", id)).ok).toBe(false);
    expect((await collectOrcaWorker(executable, id, "ctx_1")).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["nonzero exit", "timeout", "maxBuffer", "ENOENT"])("redacts subprocess failure %s", async failure => {
    reply("SECRET stdout", new Error(`SECRET ${failure}`), "SECRET stderr");
    expect(await collectOrcaWorker(executable, "runtime-1", "ctx_1")).toEqual({ ok: false, code: "CLI_FAILED" });
  });
  it("fails closed on stderr or synchronous spawn error", async () => {
    reply(receipt(), null, "warning");
    expect((await collectOrcaWorker(executable, "runtime-1", "ctx_1")).ok).toBe(false);
    execute.mockImplementation(() => { throw new Error("SECRET"); });
    expect(await collectOrcaWorker(executable, "runtime-1", "ctx_1")).toEqual({ ok: false, code: "CLI_FAILED" });
  });
  it.each(["{} trailing", '{"ok":true,"ok":false}', "null", "[]", '{"ok":false}', '{"ok":true,"result":{}}', '\ufeff{}'])
    ("rejects malformed or failed receipt %s", async raw => {
      reply(raw);
      expect(await collectOrcaWorker(executable, "runtime-1", "ctx_1")).toEqual({ ok: false, code: "INVALID_RECEIPT" });
    });
  it("rejects invalid UTF-8 instead of replacing bytes", async () => {
    reply(Buffer.from([0xff]));
    expect((await collectOrcaWorker(executable, "runtime-1", "ctx_1")).ok).toBe(false);
  });
  it.each(["runtime", "dispatch"])("rejects changed %s identity without raw output", async changed => {
    const value = receipt();
    if (changed === "runtime") value._meta.runtimeId = "other";
    else value.result.dispatch.id = "other";
    reply(value);
    expect(await collectOrcaWorker(executable, "runtime-1", "ctx_1")).toEqual({ ok: false, code: "IDENTITY_MISMATCH" });
  });
});
