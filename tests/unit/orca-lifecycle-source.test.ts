import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { inspectOrcaLifecycleSourceBytes } from "../../src/integrations/orca-lifecycle-source.js";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const binding = { agenthubTaskId: "hub", projectId: "project", revision: "3", generation: 1, runtimeId: "runtime", hostId: "local",
    runId: "run", taskId: "task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/synthetic",
    terminalHandle: "terminal", developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null };
  const question = { id: "question", type: "question", delivery_contract: "current_delivery", run_id: "run",
    from_handle: "dispatch:dispatch", to_handle: "run:run", payload: JSON.stringify({ taskId: "task", dispatchId: "dispatch" }) };
  const start = { ok: true, _meta: { runtimeId: "runtime" }, result: { runId: "run", count: 1, messages: [question],
    replayed: false, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false } };
  const confirmation = { taskId: "hub", status: "DOING", revision: 3, binding, authorizationQuestion: "question",
    developmentReleased: false, canCompleteTask: false, sourceAuthenticated: false };
  const cleanup = { ok: true, _meta: { runtimeId: "runtime" }, result: { dispatchId: "dispatch", state: "released",
    processAction: "closed_agent_terminal", archive: { source: "terminal", status: "captured" }, mutation: { replayed: false } } };
  const wrap = (v: any) => Buffer.from(JSON.stringify({ chunk_id: "chunk", exit_code: 0, original_token_count: 1, wall_time_seconds: 0.1, output: JSON.stringify(v) }));
  return { binding, start, confirmation, cleanup, wrap };
}
function run(f: ReturnType<typeof fixture>, mutateExpected: (e: any) => void = () => {}) {
  const start = f.wrap(f.start), confirmation = Buffer.from(JSON.stringify(f.confirmation)), cleanup = f.wrap(f.cleanup);
  const expected = { startupSha256: sha(start), confirmationSha256: sha(confirmation), cleanupSha256: sha(cleanup), questionId: "question" };
  mutateExpected(expected);
  return inspectOrcaLifecycleSourceBytes(JSON.stringify(f.binding), start, confirmation, cleanup,
    JSON.stringify(expected));
}
describe("partial lifecycle source matching (synthetic only, not E2E)", () => {
  it("matches identities and state but never chronology, authentication or completion", () => {
    const f = fixture(), result = run(f);
    expect(result).toMatchObject({ identityStateMatch: true, chronologyVerified: false, sourceAuthenticated: false, canCompleteTask: false });
    expect(result.lineage.startupSha256).toBe(sha(f.wrap(f.start)));
    expect(result.blockers).toContain("STARTUP_BINDING_CLEANUP_CHRONOLOGY_NOT_VERIFIED");
  });
  it.each(["runtime", "run", "sender", "receiver", "task", "dispatch", "multiple", "replay", "ack", "timeout",
    "confirmation", "revision", "releasedEarly", "releaseRuntime", "releaseDispatch", "releaseState", "close", "archive", "mutation"])("rejects %s with recomputed artifact hashes", kind => {
    const f = fixture();
    const q = f.start.result.messages[0];
    if (kind === "runtime") f.start._meta.runtimeId = "other";
    if (kind === "run") q.run_id = "other";
    if (kind === "sender") q.from_handle = "other";
    if (kind === "receiver") q.to_handle = "other";
    if (kind === "task") q.payload = JSON.stringify({ taskId: "other", dispatchId: "dispatch" });
    if (kind === "dispatch") q.payload = JSON.stringify({ taskId: "task", dispatchId: "other" });
    if (kind === "multiple") f.start.result.messages.push(q);
    if (kind === "replay") f.start.result.replayed = true;
    if (kind === "ack") (f.start.result as any).acknowledged = "question";
    if (kind === "timeout") f.start.result.timedOut = true;
    if (kind === "confirmation") f.confirmation.authorizationQuestion = "other";
    if (kind === "revision") f.confirmation.revision++;
    if (kind === "releasedEarly") f.confirmation.developmentReleased = true;
    if (kind === "releaseRuntime") f.cleanup._meta.runtimeId = "other";
    if (kind === "releaseDispatch") f.cleanup.result.dispatchId = "other";
    if (kind === "releaseState") f.cleanup.result.state = "reclaimable";
    if (kind === "close") f.cleanup.result.processAction = "none";
    if (kind === "archive") f.cleanup.result.archive.status = "pending";
    if (kind === "mutation") f.cleanup.result.mutation.replayed = true;
    expect(() => run(f)).toThrow();
  });
  it.each(["startupSha256", "confirmationSha256", "cleanupSha256", "missing", "extra", "questionId", "questionType"])("rejects malformed or stale expectation %s", key => {
    expect(() => run(fixture(), e => {
      if (key === "missing") delete e.cleanupSha256;
      else if (key === "extra") e.extra = true;
      else if (key === "questionType") e.questionId = 123;
      else e[key] = key === "questionId" ? "question\n" : "0".repeat(64);
    })).toThrow();
  });
  it.each(["agenthubTaskId", "projectId", "revision", "generation", "runtimeId", "hostId", "runId", "taskId",
    "dispatchId", "workspaceId", "workspacePath", "terminalHandle", "developer", "reviewer", "provider", "ownerId", "claimId"])("rejects independent confirmation binding mismatch %s", key => {
    const f = fixture();
    f.confirmation.binding = structuredClone(f.binding);
    const b = f.confirmation.binding as any;
    b[key] = key === "generation" ? 2 : key === "revision" ? "4" : key === "workspacePath" ? "/other" : "other";
    expect(() => run(f)).toThrow();
  });
  it("rejects all empty, wrong-typed and oversized inputs before copying", () => {
    const small = Buffer.from("{}"), large = Buffer.alloc(262145), empty = Buffer.alloc(0);
    const cases: any[][] = [];
    for (const index of [0, 1, 2]) for (const bad of [empty, null, {}, large]) {
      const args: any[] = [small, small, small, "{}"]; args[index] = bad; cases.push(args);
    }
    for (const bad of [null, {}, "", "x".repeat(4097)]) cases.push([small, small, small, bad]);
    for (const [start, confirmation, cleanup, expected] of cases) {
      const copy = vi.spyOn(Buffer, "from").mockImplementation(() => { throw Error("COPY"); });
      let error;
      try { inspectOrcaLifecycleSourceBytes("{}", start, confirmation, cleanup, expected); } catch (e) { error = e; }
      copy.mockRestore();
      expect(error).toMatchObject({ message: "INVALID_ORCA_LIFECYCLE_SOURCE" });
    }
  });
});
