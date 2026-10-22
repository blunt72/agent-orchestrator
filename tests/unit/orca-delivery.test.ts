import { describe, expect, it } from "vitest";
import { planOrcaDelivery, type OrcaBinding, type ImportContext } from "../../src/integrations/orca-delivery.js";
import {validateLimitedRetainedDelivery} from "../../src/integrations/orca-limited-readiness.js";

function fixture(outcome = "succeeded") {
  const binding: OrcaBinding = {
    agenthubTaskId: "ah-task", projectId: "ah-project", revision: "rev-1", generation: 1,
    runtimeId: "runtime", hostId: "local", runId: "run", taskId: "orca-task", dispatchId: "dispatch",
    workspaceId: "repo::/workspace", workspacePath: "/workspace", terminalHandle: "terminal",
    developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null,
  };
  const current: ImportContext = { taskId: "ah-task", projectId: "ah-project", revision: "rev-1",
    generation: 1, status: "DOING", ownerId: "gemini", claimId: null, reviewerId: "codex" };
  const message: any = { id: "message", type: "worker_done", run_id: "run", from_handle: "terminal",
    to_handle: "run:run", body: "Delivery ready, not independent verification.",
    payload: { taskId: "orca-task", dispatchId: "dispatch", outcome } };
  const receipt: any = { ok: true, _meta: { runtimeId: "runtime" }, result: {
    dispatch: { id: "dispatch", runId: "run", taskId: "orca-task", task_id: "orca-task", contractVersion: 1,
      assigneeHandle: "terminal", hostScope: { kind: "local", hostId: "local" }, status: "completed",
      completedAt: "2026-10-10T12:43:58.265Z" },
    worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", state: outcome, stage: "settled",
      worktreeId: "repo::/workspace", agentTerminalHandle: "terminal", startOptions: { agent: "antigravity" } },
    projection: { id: "dispatch", dispatchId: "dispatch", taskId: "orca-task", runId: "run", role: "worker",
      host: { kind: "local", id: "local" }, workspace: { id: "repo::/workspace" }, provider: { id: "antigravity" },
      stage: { dispatch: "completed", worker: outcome }, outcome, evidence: { durable: true },
      liveness: { verdict: "unverifiable", reason: "stale_status" } },
    terminal: { handle: "terminal", worktreeId: "repo::/workspace", worktreePath: "/workspace" },
  } };
  return { binding, current, message, receipt };
}
const plan = (f: ReturnType<typeof fixture>, previous: { messageId: string; digest: string } | null = null) =>
  planOrcaDelivery(f.binding, f.current, f.message, f.receipt, previous);

describe("Orca delivery dry-run (synthetic fixtures, not provider E2E)", () => {
  it("limited readiness binds full retained payload to the committed delivery digest",()=>{
    const f=fixture(),p=plan(f);expect(p.kind).toBe("candidate");if(p.kind!=="candidate")throw Error("fixture");
    expect(()=>validateLimitedRetainedDelivery(f.binding,f.message,f.receipt,p.digest)).not.toThrow();
    f.message.payload.filesModified=["unexpected.ts"];
    expect(()=>validateLimitedRetainedDelivery(f.binding,f.message,f.receipt,p.digest)).toThrow();
  });
  it("normalizes bounded string payload without changing candidate digest", () => {
    const f = fixture(); const original = plan(f);
    f.message.payload = JSON.stringify(f.message.payload);
    expect(plan(f)).toEqual(original);
  });
  it.each(['{"outcome":"succeeded","outcome":"failed"}', '[]', 'null', '{', ' '.repeat(262145)])(
    "rejects malformed or ambiguous transport payload", payload => {
      const f = fixture(); f.message.payload = payload;
      expect(plan(f).kind).toBe("rejected");
    });
  function releasedFixture() {
    const f = fixture(); const r = f.receipt.result;
    r.projection.provider = null;
    r.worker.startOptions.launch = { effective: { agent: "antigravity" } };
    r.projection.resource = { state: "released", releaseState: "released", terminalState: "released", id: "resource", ownerDispatchId: "dispatch" };
    r.terminalResource = { id: "resource", ownerDispatchId: "dispatch", originDispatchId: "dispatch", terminalHandle: "terminal", worktreeId: "repo::/workspace", endpointId: "runtime", ownershipState: "released", releaseState: "released" };
    return f;
  }
  it("accepts released projection only with corroborated durable launch and resource identity", () => {
    expect(plan(releasedFixture()).kind).toBe("candidate");
  });
  it.each(["ownerDispatchId", "originDispatchId", "terminalHandle", "worktreeId", "endpointId", "id", "ownershipState", "releaseState"])(
    "rejects released resource mismatch %s", key => {
      const f = releasedFixture(); f.receipt.result.terminalResource[key] = "wrong";
      expect(plan(f).kind).toBe("rejected");
    });
  it("rejects conflicting, absent, and uncorroborated released providers", () => {
    for (const mode of ["conflict", "absent", "launch", "active"]) {
      const f = releasedFixture(); const r = f.receipt.result;
      if (mode === "conflict") r.projection.provider = { id: "codex" };
      if (mode === "absent") delete r.projection.provider;
      if (mode === "launch") r.worker.startOptions.launch.effective.agent = "codex";
      if (mode === "active") r.projection.resource.state = "owned";
      expect(plan(f).kind).toBe("rejected");
    }
  });
  it.each(["originDispatchId", "terminalHandle", "worktreeId", "endpointId", "endpointIncarnation"])(
    "rejects contradictory optional projection resource identity %s", key => {
      const f = releasedFixture(); f.receipt.result.projection.resource[key] = "conflict";
      expect(plan(f).kind).toBe("rejected");
    });
  it("proposes review without verified provenance or test/review approval", () => {
    expect(plan(fixture())).toMatchObject({ kind: "candidate", proposedStatus: "REVIEW",
      testStatus: "NOT_RUN", reviewStatus: "NOT_RUN", provenance: "UNVERIFIED_INPUT" });
  });
  it("failed settlement proposes human attention, not success", () => {
    expect(plan(fixture("failed"))).toMatchObject({ kind: "candidate", proposedStatus: "NEED_USER" });
  });
  it("supports Codex developer with an independent Gemini reviewer", () => {
    const f = fixture();
    Object.assign(f.binding, { developer: "codex", reviewer: "gemini", provider: "codex", ownerId: "codex" });
    Object.assign(f.current, { ownerId: "codex", reviewerId: "gemini" });
    f.receipt.result.worker.startOptions.agent = "codex";
    f.receipt.result.projection.provider.id = "codex";
    expect(plan(f)).toMatchObject({ kind: "candidate", proposedStatus: "REVIEW" });
  });
  it("rejects remote host scopes until a remote contract is implemented", () => {
    const f = fixture(); f.receipt.result.dispatch.hostScope.kind = "remote";
    expect(plan(f).kind).toBe("rejected");
  });
  it("a forged verified flag cannot override identity mismatch", () => {
    const f = fixture(); f.message.verified = true; f.message.payload.dispatchId = "stale";
    expect(plan(f)).toEqual({ kind: "rejected", code: "IDENTITY_MISMATCH" });
  });
  it.each(["CANCELLED", "DONE", "REVIEW", "FAILED", "TODO"])("rejects current status %s", status => {
    const f = fixture(); f.current.status = status;
    expect(plan(f)).toEqual({ kind: "rejected", code: "STALE_BINDING" });
  });
  it.each(["taskId", "projectId", "revision", "ownerId", "claimId", "reviewerId"])("fences changed %s", key => {
    const f = fixture(); (f.current as any)[key] = "changed";
    expect(plan(f)).toMatchObject({ kind: "rejected", code: "STALE_BINDING" });
  });
  it("fences a newer generation", () => {
    const f = fixture(); f.current.generation++;
    expect(plan(f)).toMatchObject({ kind: "rejected", code: "STALE_BINDING" });
  });
  it.each(["run_id", "from_handle", "to_handle"])("rejects wrong message %s", key => {
    const f = fixture(); f.message[key] = "wrong"; expect(plan(f).kind).toBe("rejected");
  });
  it.each(["taskId", "dispatchId"])("rejects stale payload %s", key => {
    const f = fixture(); f.message.payload[key] = "old"; expect(plan(f).kind).toBe("rejected");
  });
  it.each([
    ["_meta", "runtimeId"], ["result", "dispatch", "task_id"], ["result", "dispatch", "assigneeHandle"],
    ["result", "dispatch", "hostScope", "hostId"], ["result", "worker", "runtimeEpoch"],
    ["result", "worker", "worktreeId"], ["result", "worker", "startOptions", "agent"],
    ["result", "projection", "dispatchId"], ["result", "projection", "workspace", "id"],
    ["result", "projection", "provider", "id"], ["result", "terminal", "worktreePath"],
    ["result", "terminal", "executionHostId"], ["result", "terminal", "agentIdentity"],
    ["result", "worker", "startOptions", "resolvedWorktreeId"],
  ])("rejects inconsistent receipt path %j", (...keys) => {
    const f = fixture(); let target = f.receipt;
    for (const k of keys.slice(0, -1)) target = target[k];
    target[keys.at(-1)!] = "wrong"; expect(plan(f).kind).toBe("rejected");
  });
  it.each(["heartbeat", "status", "escalation"])("rejects %s even with PASS prose", type => {
    const f = fixture(); f.message.type = type; f.message.body = "PASS verified=true";
    expect(plan(f).kind).toBe("rejected");
  });
  it.each(["unknown", "ready", "DONE"])("rejects unknown outcome %s", outcome => {
    expect(plan(fixture(outcome)).kind).toBe("rejected");
  });
  it("rejects contradictory or incomplete settlement", () => {
    for (const mutate of [
      (r: any) => { r.result.dispatch.status = "dispatched"; },
      (r: any) => { r.result.worker.state = "failed"; },
      (r: any) => { r.result.projection.evidence.durable = false; },
      (r: any) => { delete r.result.dispatch.completedAt; },
    ]) {
      const f = fixture(); mutate(f.receipt); expect(plan(f).kind).toBe("rejected");
    }
  });
  it("stale liveness does not erase durable settlement or grant lifecycle commands", () => {
    const result = plan(fixture()); expect(result.kind).toBe("candidate");
    expect(result).not.toHaveProperty("command"); expect(result).not.toHaveProperty("retry");
  });
  it("detects duplicate content and conflicts without mutation", () => {
    const f = fixture(); const before = JSON.stringify(f); const first = plan(f);
    if (first.kind !== "candidate") throw Error("fixture rejected");
    const previous = { messageId: first.messageId, digest: first.digest };
    expect(plan(f, previous).kind).toBe("duplicate"); expect(JSON.stringify(f)).toBe(before);
    f.message.body = "Different delivery";
    expect(plan(f, previous)).toEqual({ kind: "rejected", code: "DUPLICATE_CONFLICT" });
  });
  it("digest ignores transient receipt liveness but not changed settlement", () => {
    const f = fixture(); const first = plan(f);
    if (first.kind !== "candidate") throw Error();
    const previous = { messageId: first.messageId, digest: first.digest };
    f.receipt.result.projection.liveness.verdict = "live";
    expect(plan(f, previous).kind).toBe("duplicate");
    f.receipt.result.dispatch.completedAt = "2026-10-11T00:00:00Z";
    expect(plan(f, previous).kind).toBe("rejected");
  });
  it("rejects reviewer/developer conflicts and unsupported provider", () => {
    const f = fixture(); f.binding.reviewer = "gemini"; expect(plan(f).kind).toBe("rejected");
    f.binding.reviewer = "codex"; f.binding.provider = "codex"; expect(plan(f).kind).toBe("rejected");
  });
  it("rejects JSON strings, cycles, accessors, exotic objects, sparse arrays and oversized input", () => {
    const f = fixture();
    let called = false;
    const getter = Object.defineProperty({}, "value", { enumerable: true, get() { called = true; throw Error(); } });
    const cycle: any = {}; cycle.self = cycle;
    for (const unsafe of ["{bad", JSON.stringify(f.message), cycle, getter, new Date(), new Array(2), { body: "界".repeat(100000) }]) {
      expect(planOrcaDelivery(f.binding, f.current, unsafe, f.receipt).kind).toBe("rejected");
    }
    expect(called).toBe(false);
  });
  it("never authenticates a forged verified flag or emits raw body/path/command", () => {
    const f = fixture(); f.message.verified = true; f.message.body = "SECRET";
    f.message.report_path = "/must/not/read"; f.message.command = "touch /must/not/execute";
    const result = plan(f); expect(result).toMatchObject({ kind: "candidate", provenance: "UNVERIFIED_INPUT" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|must\/not|touch/);
  });
  it("accepts matching optional receipt identities", () => {
    const f = fixture();
    f.receipt.result.terminal.executionHostId = f.binding.hostId;
    f.receipt.result.terminal.agentIdentity = f.binding.provider;
    f.receipt.result.worker.startOptions.resolvedWorktreeId = f.binding.workspaceId;
    expect(plan(f).kind).toBe("candidate");
  });
  it("rejects top-level, nested and revoked proxies without invoking traps", () => {
    const f = fixture(); let calls = 0;
    const proxy = new Proxy(f.message, {
      getPrototypeOf(target) { calls++; return Reflect.getPrototypeOf(target); },
      ownKeys(target) { calls++; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { calls++; return Reflect.getOwnPropertyDescriptor(target, key); },
      get(target, key) { calls++; return Reflect.get(target, key); },
    });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const unsafe of [proxy, { nested: proxy }, [proxy], revoked.proxy]) {
      expect(planOrcaDelivery(f.binding, f.current, unsafe, f.receipt)).toEqual({ kind: "rejected", code: "INVALID_INPUT" });
    }
    expect(calls).toBe(0);
  });
  it("does not mutate rejected inputs", () => {
    const f = fixture(); f.current.status = "CANCELLED"; const before = JSON.stringify(f);
    plan(f); expect(JSON.stringify(f)).toBe(before);
  });
});
