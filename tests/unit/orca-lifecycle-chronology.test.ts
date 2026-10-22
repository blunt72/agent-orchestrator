import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { inspectOrcaLifecycleChronology } from "../../src/integrations/orca-lifecycle-chronology.js";
import { planOrcaDelivery } from "../../src/integrations/orca-delivery.js";
import { ORCA_SESSION_MAX_BYTES } from "../../src/integrations/orca-session-source.js";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sessionId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const binding: any = { agenthubTaskId: "hub", projectId: "project", revision: "3", generation: 1, runtimeId: "runtime", hostId: "local",
    runId: "run", taskId: "task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/synthetic", terminalHandle: "terminal",
    developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null };
  const ts = (minute: number) => `2026-10-12T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const q = { id: "question", type: "question", delivery_contract: "current_delivery", run_id: "run", from_handle: "dispatch:dispatch",
    to_handle: "run:run", payload: JSON.stringify({ taskId: "task", dispatchId: "dispatch" }), created_at: ts(0) };
  const waiting: any = { runId: "run", count: 1, messages: [q], replayed: false, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false };
  const resource = { ownerDispatchId: "dispatch", originDispatchId: "dispatch", releaseState: "not_requested" };
  const prebinding: any = { dispatch: { id: "dispatch", runId: "run", taskId: "task", status: "dispatched", assigneeHandle: "terminal" },
    worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", agentTerminalHandle: "terminal", worktreeId: "workspace", startOptions: { agent: "antigravity" } },
    terminal: { handle: "terminal", worktreeId: "workspace", worktreePath: "/synthetic" },
    projection: { dispatchId: "dispatch", runId: "run", taskId: "task", provider: { id: "antigravity" }, host: { id: "local" }, workspace: { id: "workspace" } },
    observation: { exactWorker: true }, terminalResource: { ...resource } };
  const execution_reply: any = { message: { id: "answer", type: "status", delivery_contract: "current_delivery", run_id: "run",
    from_handle: "run:run", to_handle: "dispatch:dispatch", thread_id: "question", body: "untrusted permission text", payload: null, created_at: ts(3) },
    question: { message_id: "question", run_id: "run", dispatch_id: "dispatch", asker_handle: "terminal", status: "answered",
      answer_message_id: "answer", answer_body: "untrusted permission text", created_at: ts(0), answered_at: ts(3) }, duplicate: false, mutation: { replayed: false } };
  const worker = { id: "done", type: "worker_done", delivery_contract: "current_delivery", run_id: "run", from_handle: "terminal", to_handle: "run:run",
    payload: { taskId: "task", dispatchId: "dispatch", outcome: "succeeded" }, created_at: ts(4) };
  const worker_done: any = { runId: "run", deliveryId: "delivery", count: 1, messages: [worker], replayed: false, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false };
  const settlement: any = { dispatch: { ...prebinding.dispatch, status: "completed", completedAt: ts(4), hostScope: { kind: "local", hostId: "local" } },
    worker: { ...structuredClone(prebinding.worker), state: "succeeded", stage: "settled" },
    projection: { ...prebinding.projection, id: "dispatch", role: "worker", host: { kind: "local", id: "local" }, outcome: "succeeded",
      stage: { dispatch: "completed", worker: "succeeded" }, evidence: { durable: true }, resource: { terminalState: "reclaimable" } },
    terminal: structuredClone(prebinding.terminal), terminalResource: { ...resource } };
  const cleanup: any = { dispatchId: "dispatch", state: "released", processAction: "closed_agent_terminal", archive: { source: "terminal", status: "captured" }, mutation: { replayed: false } };
  const baseline: any = { taskId: "hub", generation: 1, bindingRevision: "3", workspacePath: "/synthetic", capturedAt: ts(2), provenance: "LOCAL_PRE_BINDING_SNAPSHOT" };
  return { binding, values: { waiting, prebinding, execution_reply, worker_done, settlement, cleanup }, baseline,
    times: [ts(0), ts(1), ts(3), ts(4), ts(5), ts(6)], ts };
}
function encode(f: ReturnType<typeof fixture>) {
  const rows: any[] = [{ ordinal: 0, type: "session_meta", payload: { id: sessionId } }], selectors: any = {};
  let i = 0;
  for (const [role, value] of Object.entries(f.values)) {
    const receipt = { id: role, ok: true, _meta: { runtimeId: "runtime" }, result: value };
    const output = JSON.stringify({ chunk_id: role, exit_code: 0, original_token_count: 1, wall_time_seconds: 0.1, output: JSON.stringify(receipt) });
    const callId = `call_${role}`, ordinal = 2 * i + 2;
    rows.push({ ordinal: ordinal - 1, type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec" } });
    rows.push({ ordinal, timestamp: f.times[i++], type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: output }] } });
    selectors[role] = { sessionId, callId, toolName: "exec", ordinal, blockIndex: 0, blockSha256: sha(Buffer.from(output)) };
  }
  const source = Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  for (const selector of Object.values(selectors) as any[]) selector.sourceSha256 = sha(source);
  const receipt = { ok: true, _meta: { runtimeId: "runtime" }, result: f.values.settlement };
  const plan = planOrcaDelivery(f.binding, { taskId: "hub", projectId: "project", revision: "3", generation: 1, status: "DOING", ownerId: "gemini", claimId: null, reviewerId: "codex" }, f.values.worker_done.messages[0], receipt);
  if (plan.kind !== "candidate") throw Error("bad delivery fixture");
  const baseline = Buffer.from(JSON.stringify(f.baseline));
  return { source, baseline, selection: { selectors, baselineSha256: sha(baseline), deliveryDigest: plan.digest, messageId: "done" } };
}
const run = (f: ReturnType<typeof fixture>) => {
  const x = encode(f); return inspectOrcaLifecycleChronology(x.source, JSON.stringify(f.binding), x.baseline, JSON.stringify(x.selection));
};
describe("observed local lifecycle chronology (synthetic source, not trusted authorization)", () => {
  it("matches journal order and baseline/reply/completion times while retaining missing guarantees", () => {
    const result = run(fixture());
    expect(result).toMatchObject({ localChronologyConsistent: true, sourceAuthenticated: false, trustedClock: false,
      durableBindingTimestampProven: false, permissionDigestBound: false, canCompleteTask: false });
    expect(result.lineage).toHaveLength(6);
  });
  it.each(["journalOrder", "badDate", "baselineLate", "baselineEarly", "answerEarly", "answerFuture", "workerEarly",
    "answerThread", "answerId", "answerBody", "answerDispatch", "questionCreated", "provider", "terminal", "resource", "release", "replay",
    "workerAfterSettlement", "settlementAfterRecord"])("rejects %s with fresh source and block hashes", kind => {
    const f = fixture();
    if (kind === "journalOrder") f.times[5] = f.ts(4);
    if (kind === "badDate") f.times[0] = "2026-02-30T00:00:00.000Z";
    if (kind === "baselineLate") f.baseline.capturedAt = f.ts(4);
    if (kind === "baselineEarly") f.baseline.capturedAt = f.ts(0);
    if (kind === "answerEarly") f.values.execution_reply.message.created_at = f.values.execution_reply.question.answered_at = f.ts(1);
    if (kind === "answerFuture") f.values.execution_reply.message.created_at = f.values.execution_reply.question.answered_at = f.ts(4);
    if (kind === "workerEarly") f.values.worker_done.messages[0].created_at = f.ts(2);
    if (kind === "workerAfterSettlement") f.values.worker_done.messages[0].created_at = f.ts(5);
    if (kind === "settlementAfterRecord") f.values.settlement.dispatch.completedAt = f.ts(5);
    if (kind === "answerThread") f.values.execution_reply.message.thread_id = "other";
    if (kind === "answerId") f.values.execution_reply.question.answer_message_id = "other";
    if (kind === "answerBody") f.values.execution_reply.question.answer_body = "other";
    if (kind === "answerDispatch") f.values.execution_reply.question.dispatch_id = "other";
    if (kind === "questionCreated") f.values.execution_reply.question.created_at = f.ts(1);
    if (kind === "provider") f.values.prebinding.worker.startOptions.agent = "other";
    if (kind === "terminal") f.values.prebinding.terminal.handle = "other";
    if (kind === "resource") f.values.prebinding.terminalResource.ownerDispatchId = "other";
    if (kind === "release") f.values.cleanup.state = "pending";
    if (kind === "replay") f.values.execution_reply.mutation.replayed = true;
    expect(() => run(f)).toThrow("INVALID_ORCA_LIFECYCLE_CHRONOLOGY");
  });
  it.each([undefined, null, "", 123, "bad\n", "x".repeat(257)])("rejects invalid matching reply identifiers %s", id => {
    const f = fixture(); f.values.execution_reply.message.id = id; f.values.execution_reply.question.answer_message_id = id;
    expect(() => run(f)).toThrow("INVALID_ORCA_LIFECYCLE_CHRONOLOGY");
  });
  it.each([undefined, null, "", 123])("rejects invalid question identifiers %s", id => {
    const f = fixture(); f.values.waiting.messages[0].id = id;
    f.values.execution_reply.message.thread_id = f.values.execution_reply.question.message_id = id;
    expect(() => run(f)).toThrow("INVALID_ORCA_LIFECYCLE_CHRONOLOGY");
  });
  it("rejects reversed role ordinals even when corresponding timestamps are equal and valid", () => {
    const f = fixture(), { waiting, prebinding, ...rest } = f.values;
    f.values = { prebinding, waiting, ...rest };
    f.times[0] = f.times[1] = f.ts(1);
    expect(() => run(f)).toThrow("INVALID_ORCA_LIFECYCLE_CHRONOLOGY");
  });
  it("rejects wrong-type and oversized caller data before conversion", () => {
    const small = Buffer.from("{}"), bigSource = Buffer.alloc(ORCA_SESSION_MAX_BYTES + 1), bigBaseline = Buffer.alloc(262145);
    for (const [source, baseline, selection] of [[bigSource, small, "{}"], [small, bigBaseline, "{}"],
      [null, small, "{}"], [small, null, "{}"], [small, small, "x".repeat(32769)], [small, small, null]] as any[][]) {
      const copy = vi.spyOn(Buffer, "from").mockImplementation(() => { throw Error("COPY"); });
      let error;
      try { inspectOrcaLifecycleChronology(source, "{}", baseline, selection); } catch (e) { error = e; }
      copy.mockRestore();expect(error).toMatchObject({ message: "INVALID_ORCA_LIFECYCLE_CHRONOLOGY" });
    }
  });
  it("rejects stale pins, missing roles, duplicate role selection and baseline tampering", () => {
    const f = fixture(), x = encode(f);
    for (const mutate of [(s: any) => { s.baselineSha256 = "0".repeat(64); },
      (s: any) => { delete s.selectors.cleanup; }, (s: any) => { s.selectors.cleanup = s.selectors.settlement; },
      (s: any) => { s.selectors.waiting.sourceSha256 = "0".repeat(64); }]) {
      const s = structuredClone(x.selection); mutate(s);
      expect(() => inspectOrcaLifecycleChronology(x.source, JSON.stringify(f.binding), x.baseline, JSON.stringify(s))).toThrow();
    }
  });
});
