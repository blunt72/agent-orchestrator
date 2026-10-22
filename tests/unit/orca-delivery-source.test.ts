import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { planOrcaDelivery } from "../../src/integrations/orca-delivery.js";
import { inspectOrcaDeliverySourceBytes } from "../../src/integrations/orca-delivery-source.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const binding = { agenthubTaskId: "synthetic", projectId: "project", revision: "2", generation: 1, runtimeId: "runtime", hostId: "local",
    runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/synthetic", terminalHandle: "terminal",
    developer: "gemini" as const, reviewer: "codex" as const, provider: "antigravity" as const, ownerId: "gemini", claimId: null };
  const message: any = { id: "message", type: "worker_done", run_id: "run", from_handle: "terminal", to_handle: "run:run",
    body: "Synthetic fixture only", payload: { taskId: "orca-task", dispatchId: "dispatch", outcome: "succeeded" } };
  const receipt: any = { ok: true, _meta: { runtimeId: "runtime" }, result: {
    dispatch: { id: "dispatch", runId: "run", taskId: "orca-task", assigneeHandle: "terminal", hostScope: { kind: "local", hostId: "local" }, status: "completed", completedAt: "2026-10-12T00:00:00.000Z" },
    worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", worktreeId: "workspace", agentTerminalHandle: "terminal", startOptions: { agent: "antigravity" }, state: "succeeded", stage: "settled" },
    projection: { id: "dispatch", dispatchId: "dispatch", taskId: "orca-task", runId: "run", role: "worker", host: { kind: "local", id: "local" }, workspace: { id: "workspace" }, provider: { id: "antigravity" }, outcome: "succeeded", stage: { dispatch: "completed", worker: "succeeded" }, evidence: { durable: true } },
    terminal: { handle: "terminal", worktreeId: "workspace", worktreePath: "/synthetic" } } };
  const m = Buffer.from(JSON.stringify(message)), r = Buffer.from(JSON.stringify(receipt));
  const plan = planOrcaDelivery(binding, { taskId: "synthetic", projectId: "project", revision: "2", generation: 1, status: "DOING", ownerId: "gemini", claimId: null, reviewerId: "codex" }, message, receipt);
  if (plan.kind !== "candidate") throw Error("bad fixture");
  const expectation = { deliveryDigest: plan.digest, messageId: "message", settlementSha256: sha(r), workerDoneSha256: sha(m) };
  return { binding, message, receipt, m, r, expectation };
}
const inspect = (f = fixture()) => inspectOrcaDeliverySourceBytes(JSON.stringify(f.binding), f.m, f.r, JSON.stringify(f.expectation));
describe("original delivery byte semantics (synthetic only; no source authentication)", () => {
  it("matches original JSON bytes and imported delivery without completion authority", () => {
    const f = fixture(); expect(inspect(f)).toMatchObject({ deliveryDigest: f.expectation.deliveryDigest, semanticMatch: true, sourceAuthenticated: false, canCompleteTask: false });
  });
  it("keeps byte identity stricter than semantic JSON equality", () => {
    const f = fixture(); f.m = Buffer.concat([Buffer.from(" "), f.m]);
    expect(() => inspect(f)).toThrow("ORCA_SOURCE_BYTES_MISMATCH");
    f.expectation.workerDoneSha256 = sha(f.m); expect(inspect(f).semanticMatch).toBe(true);
  });
  it.each(["run_id", "from_handle", "to_handle", "type"])("rejects changed message identity %s even with updated byte hash", key => {
    const f = fixture(); f.message[key] = "wrong"; f.m = Buffer.from(JSON.stringify(f.message)); f.expectation.workerDoneSha256 = sha(f.m);
    expect(() => inspect(f)).toThrow("ORCA_SOURCE_SEMANTICS_MISMATCH");
  });
  it.each(["runtime", "dispatch", "run", "host", "workspace", "terminal", "provider", "settlement", "durability"])("rejects changed receipt %s with matching raw hash", kind => {
    const f = fixture(), r = f.receipt.result;
    if (kind === "runtime") f.receipt._meta.runtimeId = "other";
    if (kind === "dispatch") r.dispatch.id = "other";
    if (kind === "run") r.dispatch.runId = "other";
    if (kind === "host") r.dispatch.hostScope.hostId = "other";
    if (kind === "workspace") r.terminal.worktreePath = "/other";
    if (kind === "terminal") r.terminal.handle = "other";
    if (kind === "provider") r.projection.provider.id = "codex";
    if (kind === "settlement") r.worker.stage = "running";
    if (kind === "durability") r.projection.evidence.durable = false;
    f.r = Buffer.from(JSON.stringify(f.receipt)); f.expectation.settlementSha256 = sha(f.r);
    expect(() => inspect(f)).toThrow("ORCA_SOURCE_SEMANTICS_MISMATCH");
  });
  it("rejects coherently failed settlement, changed message ID and stale delivery digest", () => {
    const f = fixture(); f.message.payload.outcome = "failed"; f.receipt.result.worker.state = "failed";
    f.receipt.result.projection.outcome = "failed"; f.receipt.result.projection.stage.worker = "failed";
    f.m = Buffer.from(JSON.stringify(f.message)); f.r = Buffer.from(JSON.stringify(f.receipt));
    f.expectation.workerDoneSha256 = sha(f.m); f.expectation.settlementSha256 = sha(f.r);
    expect(() => inspect(f)).toThrow("ORCA_SOURCE_SEMANTICS_MISMATCH");
    for (const patch of [{ messageId: "other" }, { deliveryDigest: "a".repeat(64) }]) {
      const other = fixture(); Object.assign(other.expectation, patch); expect(() => inspect(other)).toThrow("ORCA_SOURCE_DELIVERY_MISMATCH");
    }
  });
  it("rejects invalid UTF-8, duplicate keys, summaries, BOM and oversized source", () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from('{"id":"message","id":"message"}'), Buffer.from("worker completed successfully"),
      Buffer.from("\ufeff{}"), Buffer.alloc(262145, 32)]) {
      const f = fixture(); f.m = bytes; f.expectation.workerDoneSha256 = sha(bytes); expect(() => inspect(f)).toThrow("INVALID_ORCA_DELIVERY_SOURCE");
    }
  });
  it("rejects expectation aliases, duplicates, missing/extra fields and oversized input", () => {
    const f = fixture(); const raw = JSON.stringify(f.expectation);
    for (const bad of [raw.replace('"messageId":"message"', '"messageId":"message","\\u006dessageId":"message"'),
      JSON.stringify({ ...f.expectation, extra: true }), JSON.stringify({ ...f.expectation, messageId: "message\n" }),
      JSON.stringify({ ...f.expectation, workerDoneSha256: "A".repeat(64) }), "{}", " ".repeat(32769) + raw])
      expect(() => inspectOrcaDeliverySourceBytes(JSON.stringify(f.binding), f.m, f.r, bad)).toThrow("INVALID_ORCA_DELIVERY_SOURCE");
  });
  it("accepts released provider only with corroborated launch and resource identity", () => {
    const f = fixture(), r = f.receipt.result;
    r.projection.provider = null;
    r.worker.startOptions.launch = { effective: { agent: "antigravity" } };
    r.projection.resource = { id: "resource", state: "released", releaseState: "released", terminalState: "released", ownerDispatchId: "dispatch" };
    r.terminalResource = { id: "resource", ownerDispatchId: "dispatch", originDispatchId: "dispatch", terminalHandle: "terminal", worktreeId: "workspace", endpointId: "runtime", ownershipState: "released", releaseState: "released" };
    f.r = Buffer.from(JSON.stringify(f.receipt)); f.expectation.settlementSha256 = sha(f.r);
    expect(inspect(f).semanticMatch).toBe(true);
    r.terminalResource.ownerDispatchId = "different";
    f.r = Buffer.from(JSON.stringify(f.receipt)); f.expectation.settlementSha256 = sha(f.r);
    expect(() => inspect(f)).toThrow("ORCA_SOURCE_SEMANTICS_MISMATCH");
  });
  it("checks exact source and expectation byte limits without relaxing JSON semantics", () => {
    const f = fixture(); f.message.body = "\u4e2d";
    f.m = Buffer.from(JSON.stringify(f.message)); f.m = Buffer.concat([f.m, Buffer.alloc(262144 - f.m.length, 32)]);
    f.expectation.workerDoneSha256 = sha(f.m);
    // Body changes alter the delivery digest; obtain the corresponding explicit expectation.
    const plan = planOrcaDelivery(f.binding, { taskId: "synthetic", projectId: "project", revision: "2", generation: 1, status: "DOING", ownerId: "gemini", claimId: null, reviewerId: "codex" }, f.message, f.receipt);
    if (plan.kind !== "candidate") throw Error("bad fixture"); f.expectation.deliveryDigest = plan.digest;
    const raw = JSON.stringify(f.expectation), exact = raw + " ".repeat(32768 - Buffer.byteLength(raw));
    expect(inspectOrcaDeliverySourceBytes(JSON.stringify(f.binding), f.m, f.r, exact).semanticMatch).toBe(true);
    expect(() => inspectOrcaDeliverySourceBytes(JSON.stringify(f.binding), f.m, f.r, exact + " ")).toThrow("INVALID_ORCA_DELIVERY_SOURCE");
    f.m = Buffer.concat([f.m, Buffer.from(" ")]); f.expectation.workerDoneSha256 = sha(f.m);
    expect(() => inspect(f)).toThrow("INVALID_ORCA_DELIVERY_SOURCE");
    const other = fixture(); other.r = Buffer.concat([other.r, Buffer.alloc(262144 - other.r.length, 32)]); other.expectation.settlementSha256 = sha(other.r);
    expect(inspect(other).semanticMatch).toBe(true);
    other.r = Buffer.concat([other.r, Buffer.from(" ")]); other.expectation.settlementSha256 = sha(other.r);
    expect(() => inspect(other)).toThrow("INVALID_ORCA_DELIVERY_SOURCE");
  });
  it("rejects duplicate nested receipt identities even if byte hash is updated", () => {
    const f = fixture(); f.r = Buffer.from(f.r.toString().replace('"runtimeId":"runtime"', '"runtimeId":"runtime","\\u0072untimeId":"runtime"'));
    f.expectation.settlementSha256 = sha(f.r); expect(() => inspect(f)).toThrow("INVALID_ORCA_DELIVERY_SOURCE");
  });
  it("preserves JSON-string payload compatibility", () => {
    const f = fixture(); f.message.payload = JSON.stringify(f.message.payload); f.m = Buffer.from(JSON.stringify(f.message));
    f.expectation.workerDoneSha256 = sha(f.m); expect(inspect(f).semanticMatch).toBe(true);
  });
  it.each(["message/1", "\u6d88\u606f/1", "x".repeat(4096)])("accepts planner-compatible message ID %s", messageId => {
    const f = fixture(); f.message.id = messageId; f.m = Buffer.from(JSON.stringify(f.message));
    f.expectation.messageId = messageId; f.expectation.workerDoneSha256 = sha(f.m);
    const plan = planOrcaDelivery(f.binding, { taskId: "synthetic", projectId: "project", revision: "2", generation: 1, status: "DOING", ownerId: "gemini", claimId: null, reviewerId: "codex" }, f.message, f.receipt);
    if (plan.kind !== "candidate") throw Error("bad fixture"); f.expectation.deliveryDigest = plan.digest;
    expect(inspect(f).semanticMatch).toBe(true);
  });
});
