import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectRelayJournal, persistRelayIntent, persistRelayReceipt, persistRelayRecovery, inspectRelayRecovery } from "../../src/integrations/orca-relay-journal.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const request = Buffer.from("exact request\n"), receipt = Buffer.from('{"ok":true}\n');
const identity = { runtimeId: "runtime", callerId: "caller", taskId: "task", generation: 1,
  bindingDigest: "a".repeat(64), policyDigest: "b".repeat(64) };
const intent = { version: 1, identity, operationId: "request", requestDigest: sha(request), kind: "reply", phase: "INTENT", receiptDigest: null };
const observation = { identity, operationId: "request", requestDigest: sha(request), status: "completed", receiptDigest: sha(receipt) };
const raw = JSON.stringify(intent), observed = JSON.stringify(observation), current = JSON.stringify(identity);
const remoteId = "12345678-1234-1234-1234-123456789abc";
const recovery = (id = remoteId) => Buffer.from(JSON.stringify({ id: "error", ok: false,
  _meta: { runtimeId: identity.runtimeId }, error: { code: "runtime_timeout", data: { orchestrationRequestId: id } } }));
let root: string;
const dir = () => path.join(root, "data/orca-relay-journal-v1");
async function file(suffix: string) { return path.join(dir(), (await fs.readdir(dir())).find(n => n.endsWith(suffix))!); }
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "relay-journal-"))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("synthetic local filesystem relay journal, no provider", () => {
  it("retains remote UUID separately from local operation ID", async () => {
    await persistRelayIntent(root, raw, request);
    expect(await persistRelayRecovery(root, raw, current, recovery())).toBe("written");
    expect(await persistRelayRecovery(root, raw, current, recovery())).toBe("duplicate");
    expect(await inspectRelayRecovery(root, raw, current)).toMatchObject({ requestId: remoteId,
      nextAction: "LOOKUP_REQUEST", associationAuthenticated: false, canReplay: false });
    const saved = JSON.parse(await fs.readFile(await file(".recovery.json"), "utf8"));
    expect(Buffer.from(saved.bytes, "base64")).toEqual(recovery());
  });
  it("missing remote ID never allows first-send replay", async () => {
    await persistRelayIntent(root, raw, request);
    expect(await inspectRelayRecovery(root, raw, current)).toMatchObject({ requestId: null, nextAction: "INSPECT_REMOTE", canReplay: false });
  });
  it("rejects replacement remote UUID", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayRecovery(root, raw, current, recovery());
    await expect(persistRelayRecovery(root, raw, current, recovery("22345678-1234-1234-1234-123456789abc"))).rejects.toThrow();
    expect((await inspectRelayRecovery(root, raw, current)).requestId).toBe(remoteId);
  });
  it("requires original intent and refuses orphan recovery backfill", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayRecovery(root, raw, current, recovery());
    await fs.unlink(await file(".intent.json"));
    await expect(persistRelayRecovery(root, raw, current, recovery())).rejects.toThrow();
    await expect(persistRelayIntent(root, raw, request)).rejects.toThrow();
  });
  it("rejects drift before persistence and on recovery readback", async () => {
    await persistRelayIntent(root, raw, request);
    const drift = JSON.stringify({ ...identity, callerId: "other" });
    await expect(persistRelayRecovery(root, raw, drift, recovery())).rejects.toThrow();
    await expect(inspectRelayRecovery(root, raw, drift)).rejects.toThrow();
  });
  it("rechecks original error bytes and association metadata", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayRecovery(root, raw, current, recovery());
    const name = await file(".recovery.json"), value = JSON.parse(await fs.readFile(name, "utf8"));
    value.record.requestId = "22345678-1234-1234-1234-123456789abc";
    await fs.writeFile(name, JSON.stringify(value));
    await expect(inspectRelayRecovery(root, raw, current)).rejects.toThrow();
  });
  it("persists intent, restarts unknown, then retains exact receipt", async () => {
    expect(await persistRelayIntent(root, raw, request)).toBe("written");
    expect(await inspectRelayJournal(root, raw, current)).toMatchObject({ action: "INSPECT_REMOTE", receiptRetained: false, canReplay: false });
    expect(await persistRelayReceipt(root, raw, observed, receipt)).toBe("written");
    expect(await inspectRelayJournal(root, raw, current)).toMatchObject({ action: "RETAINED", receiptRetained: true, canCompleteTask: false });
    const data = JSON.parse(await fs.readFile(await file(".receipt.json"), "utf8"));
    expect(Buffer.from(data.bytes, "base64")).toEqual(receipt);
  });
  it("idempotently repeats writes without changing bytes", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayReceipt(root, raw, observed, receipt);
    const name = await file(".receipt.json"), before = await fs.readFile(name);
    expect(await persistRelayIntent(root, raw, request)).toBe("duplicate");
    expect(await persistRelayReceipt(root, raw, observed, receipt)).toBe("duplicate");
    expect(await fs.readFile(name)).toEqual(before);
  });
  it("rejects conflicting intent under same operation key", async () => {
    await persistRelayIntent(root, raw, request);
    await expect(persistRelayIntent(root, JSON.stringify({ ...intent, kind: "cleanup" }), request)).rejects.toThrow();
  });
  it("rejects conflicting receipt and preserves original", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayReceipt(root, raw, observed, receipt);
    const other = Buffer.from("different");
    await expect(persistRelayReceipt(root, raw, JSON.stringify({ ...observation, receiptDigest: sha(other) }), other)).rejects.toThrow();
    expect((await inspectRelayJournal(root, raw, current)).action).toBe("RETAINED");
  });
  it("requires a retained intent before receipt publication", async () => {
    await persistRelayIntent(root, raw, request);
    await fs.unlink(await file(".intent.json"));
    await expect(persistRelayReceipt(root, raw, observed, receipt)).rejects.toThrow();
  });
  it("does not backfill an intent beneath an orphan receipt", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayReceipt(root, raw, observed, receipt);
    const name = await file(".intent.json"); await fs.unlink(name);
    await expect(persistRelayIntent(root, raw, request)).rejects.toThrow();
    await expect(fs.stat(name)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("detects current caller drift even with retained receipt", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayReceipt(root, raw, observed, receipt);
    expect((await inspectRelayJournal(root, raw, JSON.stringify({ ...identity, callerId: "other" }))).action).toBe("CONFLICT");
  });
  it("rejects wrong request bytes without creating storage", async () => {
    await expect(persistRelayIntent(root, raw, receipt)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("rejects wrong receipt bytes and non-completed observations", async () => {
    await persistRelayIntent(root, raw, request);
    await expect(persistRelayReceipt(root, raw, observed, request)).rejects.toThrow();
    await expect(persistRelayReceipt(root, raw, JSON.stringify({ ...observation, status: "pending", receiptDigest: null }), receipt)).rejects.toThrow();
  });
  it.each([Buffer.alloc(0), Buffer.alloc(65537)])("bounds raw artifacts %#", async b => {
    await expect(persistRelayIntent(root, JSON.stringify({ ...intent, requestDigest: sha(b) }), b)).rejects.toThrow();
  });
  it("detects truncated journal without repair", async () => {
    await persistRelayIntent(root, raw, request);
    const name = await file(".intent.json"); await fs.writeFile(name, "{");
    await expect(inspectRelayJournal(root, raw, current)).rejects.toThrow();
    expect(await fs.readFile(name, "utf8")).toBe("{");
  });
  it("detects tampered receipt bytes", async () => {
    await persistRelayIntent(root, raw, request); await persistRelayReceipt(root, raw, observed, receipt);
    const name = await file(".receipt.json"), data = JSON.parse(await fs.readFile(name, "utf8"));
    data.bytes = request.toString("base64"); await fs.writeFile(name, JSON.stringify(data));
    await expect(inspectRelayJournal(root, raw, current)).rejects.toThrow();
  });
  it.each(["null", "[]"])("rejects corrupt receipt %s rather than treating it as absent", async value => {
    await persistRelayIntent(root, raw, request); await persistRelayReceipt(root, raw, observed, receipt);
    await fs.writeFile(await file(".receipt.json"), value);
    await expect(inspectRelayJournal(root, raw, current)).rejects.toThrow();
  });
  it("failure before publication leaves intent unknown and no receipt", async () => {
    await persistRelayIntent(root, raw, request);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Error("injected before publication"));
    await expect(persistRelayReceipt(root, raw, observed, receipt)).rejects.toThrow("injected");
    expect((await inspectRelayJournal(root, raw, current)).action).toBe("INSPECT_REMOTE");
    expect((await fs.readdir(dir())).filter(n => n.endsWith(".tmp"))).toHaveLength(0);
  });
  it("failure after publication can retain a receipt despite rejection", async () => {
    await persistRelayIntent(root, raw, request);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementationOnce(async name => {
      if (String(name).endsWith(".tmp")) throw Error("injected after publication");
      return unlink(name);
    });
    await expect(persistRelayReceipt(root, raw, observed, receipt)).rejects.toThrow("injected");
    vi.restoreAllMocks();
    expect((await inspectRelayJournal(root, raw, current)).action).toBe("RETAINED");
    expect(await persistRelayReceipt(root, raw, observed, receipt)).toBe("duplicate");
  });
  it("refuses a symlink journal directory", async () => {
    await fs.mkdir(path.join(root, "data")); await fs.mkdir(path.join(root, "other"));
    await fs.symlink(path.join(root, "other"), dir());
    await expect(persistRelayIntent(root, raw, request)).rejects.toThrow();
    expect(await fs.readdir(path.join(root, "other"))).toEqual([]);
  });
  it("refuses symlink entries and multi-link crash remnants", async () => {
    await persistRelayIntent(root, raw, request);
    const name = await file(".intent.json"), extra = path.join(root, "copy");
    await fs.link(name, extra);
    await expect(inspectRelayJournal(root, raw, current)).rejects.toThrow();
    await fs.unlink(extra); await fs.rename(name, extra); await fs.symlink(extra, name);
    await expect(inspectRelayJournal(root, raw, current)).rejects.toThrow();
  });
  it("preserves orphan execution lock, never steals it", async () => {
    await persistRelayIntent(root, raw, request);
    const lock = path.join(root, "data/task-executions", sha(Buffer.from(identity.taskId)) + ".lock");
    await fs.writeFile(lock, "orphan", { mode: 0o600 });
    await expect(persistRelayIntent(root, raw, request)).rejects.toThrow("RELAY_BUSY");
    expect(await fs.readFile(lock, "utf8")).toBe("orphan");
  });
  it("allows at most one participating concurrent writer, with identical replay allowed", async () => {
    await persistRelayIntent(root, raw, request);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => persistRelayReceipt(root, raw, observed, receipt)));
    expect(results.filter(r => r.status === "fulfilled" && r.value === "written")).toHaveLength(1);
    expect((await inspectRelayJournal(root, raw, current)).action).toBe("RETAINED");
    expect((await fs.readdir(dir())).filter(n => n.endsWith(".receipt.json"))).toHaveLength(1);
  });
});
