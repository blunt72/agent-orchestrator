import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ getTask: vi.fn(), read: vi.fn(), acceptance: vi.fn(), attribution: vi.fn(),
  manifest: vi.fn(), delivery: vi.fn(), review: vi.fn(), fingerprint: vi.fn(), roots: [] as string[] }));
vi.mock("../../src/integrations/orca-read-only-store.js", () => ({ OrcaReadOnlyStore: class {
  constructor(root: string) { calls.roots.push(root); }
  getTask = calls.getTask;
  readOrcaEvidence = calls.read;
  verifyTaskEventReadOnly = vi.fn();
} }));
vi.mock("../../src/integrations/orca-acceptance.js", async original => ({ ...await original<any>(), inspectOrcaAcceptance: calls.acceptance }));
vi.mock("../../src/integrations/orca-baseline.js", () => ({ inspectOrcaFileAttribution: calls.attribution }));
vi.mock("../../src/integrations/orca-evidence-manifest.js", async original => ({ ...await original<any>(), inspectOrcaEvidenceManifest: calls.manifest }));
vi.mock("../../src/integrations/orca-delivery-evidence.js", () => ({ inspectOrcaDeliveryEvidenceBytes: calls.delivery }));
vi.mock("../../src/integrations/orca-review-source.js", () => ({ inspectOrcaReviewSourceBytes: calls.review }));
vi.mock("../../src/integrations/orca-tests.js", () => ({ fingerprintOrcaWorkspace: calls.fingerprint }));
import { inspectOrcaCompletionReadiness, inspectOrcaCompletionSnapshotReadiness } from "../../src/integrations/orca-completion-readiness.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
let root: string, sessions: string, filename: string, task: any, enrollment: any, entries: any[];
const hash = "a".repeat(64), workspace = "b".repeat(64);
const writeEnrollment = () => fs.writeFileSync(filename, JSON.stringify(enrollment), { mode: 0o600 });
const run = () => inspectOrcaCompletionReadiness(root, sessions, "task", "{}", hash);
beforeEach(() => {
  vi.clearAllMocks(); calls.roots.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-readiness-")));
  sessions = path.join(root, "sessions"); fs.mkdirSync(sessions);
  fs.mkdirSync(path.join(root, "data", "orca-trust-v1"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "data", "orca-evidence-v1"));
  filename = path.join(root, "data", "orca-trust-v1", "enrollment.json");
  const binding = { agenthubTaskId: "task", projectId: "project", revision: "3", generation: 1, runtimeId: "runtime", hostId: "local", runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: root, terminalHandle: "terminal", developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null };
  enrollment = { version: 1, purpose: "LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT", registeredAt: "2026-10-12T13:20:21.211Z",
    operator: { namespace: "agenthub-local-operator-v1", subject: "aaaaaaaa-0000-4000-8000-000000000005" },
    scope: { taskId: "task", projectId: "project", generation: 1, bindingDigest: parseOrcaCompletionBinding(JSON.stringify(binding)).digest },
    evidenceRoots: [sessions, path.join(root, "data", "orca-evidence-v1")], authorizationBasis: "synthetic fixture only",
    sourceAuthenticated: false, canCompleteTask: false }; writeEnrollment();
  const ref = { sha256: hash, bytes: 5 };
  task = { id: "task", revision: 10, status: "REVIEW", orcaGeneration: 1, orcaBinding: binding,
    orcaDelivery: { digest: hash, messageId: "message" }, orcaTestRun: { id: "tests", workspaceHash: workspace, outputHash: hash, outputEvidence: ref },
    orcaReviewRun: { id: "review", responseHash: hash }, orcaBaseline: { evidence: ref } };
  entries = ["worker_done", "settlement", "review_response", "test_output"].map(role => ({ role, evidence: ref,
    sourceReceipt: role === "worker_done" ? "message" : role === "review_response" ? "review" : role === "test_output" ? "tests" : role }));
  calls.getTask.mockImplementation(async () => structuredClone(task));
  calls.read.mockResolvedValue(Buffer.from('{"allowedFiles":["test.ts"]}'));
  calls.acceptance.mockResolvedValue({ localEvidenceConsistent: true, canCompleteTask: false });
  calls.attribution.mockResolvedValue({ withinWhitelist: true, workspaceHash: workspace, baselineHash: hash });
  calls.manifest.mockImplementation(async () => ({ manifest: { entries: structuredClone(entries) } }));
  calls.delivery.mockReturnValue({}); calls.review.mockReturnValue({}); calls.fingerprint.mockResolvedValue(workspace);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("prepares subjects only (synthetic mocked stages, real enrollment; NOT E2E)", async () => {
  const before = JSON.stringify(task), result = await run();
  expect(result).toMatchObject({ localChecksPassed: true, approvalIssued: false, sourceAuthenticated: false, canCompleteTask: false,
    approvalSubjects: { operator: enrollment.operator, expectedRevision: 10, bindingDigest: enrollment.scope.bindingDigest, allowedFiles: ["test.ts"] } });
  expect(result.approvalSubjects).not.toHaveProperty("approvalId");
  expect(result.approvalSubjects).not.toHaveProperty("approvedAt");
  expect(result.blockers).toContain("EXACT_HUMAN_COMPLETION_APPROVAL_ABSENT");
  expect(result.blockers).toContain("COMPLETION_WRITEBACK_DISABLED");
  expect(calls.roots).toEqual([root]); expect(JSON.stringify(task)).toBe(before);
});
it("rejects unbound task before enrollment or evidence", async () => {
  delete task.orcaBinding; const result = await run(); expect(result.blockers).toContain("CURRENT_TASK_FAILED");
  expect(calls.acceptance).not.toHaveBeenCalled(); expect(calls.read).not.toHaveBeenCalled();
});
it.each(["result", "pendingAgentTurn", "status", "orcaGeneration", "id"])("rejects invalid task %s", async key => {
  task[key] = key === "orcaGeneration" ? 2 : "invalid";
  expect((await run()).blockers).toContain("CURRENT_TASK_FAILED");
});
it("rejects missing enrollment before downstream inspection", async () => {
  fs.unlinkSync(filename); expect((await run()).blockers).toContain("LOCAL_ENROLLMENT_FAILED"); expect(calls.acceptance).not.toHaveBeenCalled();
});
it("rejects another task enrollment", async () => {
  enrollment.scope.taskId = "other"; writeEnrollment(); expect((await run()).blockers).toContain("LOCAL_ENROLLMENT_FAILED");
});
it.each(["acceptance", "attribution", "manifest", "delivery", "review"])("fails closed at %s without leaking exceptions", async key => {
  (calls[key as keyof typeof calls] as any).mockImplementation(() => { throw Error("SECRET_SOURCE_CONTENT"); });
  const result = await run(); expect(result.localChecksPassed).toBe(false); expect(result).not.toHaveProperty("approvalSubjects");
  expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE_CONTENT"); expect(result.canCompleteTask).toBe(false);
});
it("rejects out-of-whitelist attribution", async () => {
  calls.attribution.mockResolvedValue({ withinWhitelist: false, workspaceHash: workspace, baselineHash: hash });
  expect((await run()).blockers).toContain("FILE_ATTRIBUTION_FAILED");
});
it.each([["../outside"], ["b", "a"], ["a", "a"], [], [".git/config"]])("rejects invalid whitelist %j", async files => {
  calls.read.mockResolvedValue(Buffer.from(JSON.stringify({ allowedFiles: files })));
  expect((await run()).blockers).toContain("FILE_ATTRIBUTION_FAILED");
});
it("rejects test evidence link mismatch", async () => {
  entries.find(e => e.role === "test_output").evidence = { sha256: workspace, bytes: 5 };
  expect((await run()).blockers).toContain("MANIFEST_INTEGRITY_FAILED");
});
it("rejects changed task at final check", async () => {
  calls.getTask.mockResolvedValueOnce(structuredClone(task)).mockResolvedValue({ ...task, revision: 11 });
  expect((await run()).blockers).toContain("FINAL_SNAPSHOT_FAILED");
});
it("rejects changed enrollment during awaits", async () => {
  calls.acceptance.mockImplementation(async () => { enrollment.operator.subject = "11111111-1111-4111-8111-111111111111"; writeEnrollment(); return {}; });
  expect((await run()).blockers).toContain("FINAL_SNAPSHOT_FAILED");
});
it("rejects workspace drift", async () => {
  calls.fingerprint.mockResolvedValue("c".repeat(64)); expect((await run()).blockers).toContain("FINAL_SNAPSHOT_FAILED");
});
it("rejects oversized input before store construction", async () => {
  expect((await inspectOrcaCompletionReadiness(root, sessions, "task", " ".repeat(32769), hash)).blockers).toContain("INPUT_FAILED");
  expect(calls.roots).toEqual([]);
});
const expectFailure = (result: Awaited<ReturnType<typeof run>>, stage: string) => {
  expect(result.blockers).toContain(stage + "_FAILED"); expect(result).not.toHaveProperty("approvalSubjects");
  expect(result.blockers).toContain("COMPLETION_WRITEBACK_DISABLED"); expect(result.approvalIssued).toBe(false);
};
it.each(["projectId", "generation", "bindingDigest"])("rejects enrollment scope %s mismatch", async key => {
  enrollment.scope[key] = key === "generation" ? 2 : key === "bindingDigest" ? "c".repeat(64) : "other";
  writeEnrollment(); expectFailure(await run(), "LOCAL_ENROLLMENT");
});
it.each(["worker_done", "test_output", "review_response"])("rejects %s source receipt mismatch", async role => {
  entries.find(e => e.role === role).sourceReceipt = "other"; expectFailure(await run(), "MANIFEST_INTEGRITY");
});
it("rejects review byte hash mismatch", async () => {
  entries.find(e => e.role === "review_response").evidence = { sha256: workspace, bytes: 5 };
  expectFailure(await run(), "MANIFEST_INTEGRITY");
});
it.each(["workspaceHash", "baselineHash"])("rejects attribution %s mismatch", async key => {
  calls.attribution.mockResolvedValue({ withinWhitelist: true, workspaceHash: workspace, baselineHash: hash, [key]: "c".repeat(64) });
  expectFailure(await run(), "FILE_ATTRIBUTION");
});
it("rejects failure specifically on final manifest recheck", async () => {
  calls.manifest.mockResolvedValueOnce({ manifest: { entries } }).mockRejectedValueOnce(Error("SECRET_SOURCE_CONTENT"));
  const result = await run(); expectFailure(result, "FINAL_SNAPSHOT");
  expect(calls.manifest).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE_CONTENT");
});
it("rejects enrollment drift during final task read", async () => {
  let count = 0;
  calls.getTask.mockImplementation(async () => {
    if (++count === 2) { enrollment.operator.subject = "11111111-1111-4111-8111-111111111111"; writeEnrollment(); }
    return structuredClone(task);
  });
  expectFailure(await run(), "FINAL_SNAPSHOT"); expect(count).toBe(2);
});
it("rejects enrollment drift during final workspace await", async () => {
  calls.fingerprint.mockImplementation(async () => {
    enrollment.operator.subject = "11111111-1111-4111-8111-111111111111"; writeEnrollment(); return workspace;
  });
  expectFailure(await run(), "FINAL_SNAPSHOT");
});
it("rechecks an original snapshot without rewriting a live completed task (synthetic)", async () => {
  const original = structuredClone(task), completed = { ...task, status: "DONE", revision: 12, result: { status: "PASS" } };
  calls.getTask.mockImplementation(async () => structuredClone(completed));
  const result = await inspectOrcaCompletionSnapshotReadiness(root, sessions, "task", "{}", hash, original);
  expect(result.localChecksPassed).toBe(true); expect(result.canCompleteTask).toBe(false);
  expect(result.approvalSubjects?.expectedRevision).toBe(10); expect(calls.getTask).toHaveBeenCalledTimes(2);
  expect(original).toEqual(task);
});
it("rejects live mutation while checking an immutable original snapshot", async () => {
  calls.getTask.mockResolvedValueOnce({ ...task, status: "DONE", revision: 11 }).mockResolvedValue({ ...task, status: "DONE", revision: 12 });
  const result = await inspectOrcaCompletionSnapshotReadiness(root, sessions, "task", "{}", hash, task);
  expect(result.localChecksPassed).toBe(false); expect(result.blockers).toContain("FINAL_SNAPSHOT_FAILED");
});
