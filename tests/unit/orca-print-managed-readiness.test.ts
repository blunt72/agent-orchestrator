import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ task: vi.fn(), enrollment: vi.fn(), review: vi.fn(), managed: vi.fn() }));
vi.mock("../../src/integrations/orca-print-completion-readiness.js", () => ({ readOrcaPrintTaskSnapshot: mocks.task, inspectOrcaPrintCompletionReadiness: mocks.review }));
vi.mock("../../src/integrations/orca-local-enrollment.js", () => ({ readOrcaTaskEnrollment: mocks.enrollment }));
vi.mock("../../src/integrations/orca-managed-terminal.js", () => ({ inspectOrcaManagedReleaseEvidence: mocks.managed }));
import { inspectOrcaPrintManagedReadiness } from "../../src/integrations/orca-print-managed-readiness.js";
const digest = "a".repeat(64), incarnation = "11111111-1111-4111-8111-111111111111";
const binding = { agenthubTaskId: "task", projectId: "project", revision: "4", generation: 1, runtimeId: "runtime", hostId: "local",
  runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/workspace",
  terminalHandle: "terminal", developer: "codex", reviewer: "gemini", provider: "codex", ownerId: "codex", claimId: null };
const task = { id: "task", projectId: "project", status: "REVIEW", revision: 11, orcaBinding: binding };
const expectation = { revision: 11, attempt: "initial" as const, finalizationHash: digest, enrollmentDigest: digest,
  settlementSha256: digest, releaseSha256: digest, workerIncarnation: incarnation, resourceId: "resource" };
const run = () => inspectOrcaPrintManagedReadiness("/store", "/sessions", "task", expectation, Buffer.from("settlement"), Buffer.from("release"));
const reviewSubjects = () => ({ taskId: "task", revision: 11, bindingHash: digest, deliveryDigest: digest,
  testRunHash: digest, finalizationHash: digest, captureHash: digest, workspaceHash: digest, changedFiles: ["test/a.mjs"] });
beforeEach(() => {
  vi.resetAllMocks(); mocks.task.mockImplementation(() => structuredClone(task));
  mocks.enrollment.mockReturnValue({ digest, operator: { namespace: "agenthub-local-operator-v1", subject: "user" } });
  mocks.review.mockResolvedValue({ subjects: reviewSubjects() }); mocks.managed.mockReturnValue({ resourceId: "resource" });
});
it("composes synthetic dependencies into draft subjects only, never approval or release", async () => {
  const r = await run(); expect(r).toMatchObject({ localChecksPassed: true, canReleaseWorker: false, canCompleteTask: false,
    approvalIssued: false, sourceAuthenticated: false, globalGateApproved: false, subjects: { resourceId: "resource", attempt: "initial" } });
  expect(r.blockers).toContain("MANAGED_COMPLETION_TRANSACTION_NOT_IMPLEMENTED");
});
it.each(["enrollment", "review", "managed"])("rejects failed %s dependency", async key => {
  mocks[key as "review"].mockImplementation(() => { throw Error("rejected"); }); await expect(run()).rejects.toThrow();
});
it.each(["orcaPrintTaskCompletion", "orcaTaskCompletion", "orcaCompletion"])("rejects prior completion route %s", key => {
  mocks.task.mockReturnValue({ ...task, [key]: {} }); return expect(run()).rejects.toThrow();
});
it("rejects enrollment-pin mismatch", async () => {
  mocks.enrollment.mockReturnValue({ digest: "b".repeat(64) }); await expect(run()).rejects.toThrow();
});
it.each(["task", "enrollment"])("rejects final synchronous %s drift", async key => {
  if (key === "task") mocks.task.mockReturnValueOnce(task).mockReturnValue({ ...task, revision: 12 });
  else mocks.enrollment.mockReturnValueOnce({ digest }).mockReturnValue({ digest: "b".repeat(64) });
  await expect(run()).rejects.toThrow();
});
it("copies caller buffers before awaited checks", async () => {
  const s = Buffer.from("settlement"), r = Buffer.from("release");
  mocks.review.mockImplementation(async () => { s.fill(0); r.fill(0); return { subjects: reviewSubjects() }; });
  await inspectOrcaPrintManagedReadiness("/store", "/sessions", "task", expectation, s, r);
  expect(mocks.managed.mock.calls[0][1].toString()).toBe("settlement");
});
it.each(["missing", "extra", "traversal"])("rejects malformed composed review subjects: %s", async kind => {
  const subjects: any = reviewSubjects();
  if (kind === "missing") delete subjects.captureHash;
  if (kind === "extra") subjects.canCompleteTask = true;
  if (kind === "traversal") subjects.changedFiles = ["../escape"];
  mocks.review.mockResolvedValue({ subjects });
  await expect(run()).rejects.toThrow("INVALID_MANAGED_DRAFT_SUBJECTS");
});
it("rejects empty or oversized raw buffers and expanded expectations", async () => {
  for (const b of [Buffer.alloc(0), Buffer.alloc(262145)])
    await expect(inspectOrcaPrintManagedReadiness("/store", "/sessions", "task", expectation, b, Buffer.from("release"))).rejects.toThrow();
  await expect(inspectOrcaPrintManagedReadiness("/store", "/sessions", "task", { ...expectation, approve: true } as any, Buffer.from("s"), Buffer.from("r"))).rejects.toThrow();
});
it.each([
  { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
  { attempt: "unknown" }, { finalizationHash: "a".repeat(64) + "\n" },
  { enrollmentDigest: null }, { settlementSha256: "bad" }, { releaseSha256: 123 },
  { workerIncarnation: incarnation + "\n" }, { resourceId: "resource\n" }, { resourceId: "x".repeat(257) },
])("rejects invalid expectations before any task or enrollment read: %j", async patch => {
  await expect(inspectOrcaPrintManagedReadiness("/store", "/sessions", "task",
    { ...expectation, ...patch } as any, Buffer.from("s"), Buffer.from("r"))).rejects.toThrow("PRINT_MANAGED_READINESS_FAILED");
  expect(mocks.task).not.toHaveBeenCalled();
  expect(mocks.enrollment).not.toHaveBeenCalled();
  expect(mocks.managed).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});
