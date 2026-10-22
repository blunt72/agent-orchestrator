import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ task: vi.fn(), enrollment: vi.fn(), policy: vi.fn(), workspace: vi.fn() }));
vi.mock("../../src/integrations/orca-print-completion-readiness.js", () => ({ readOrcaPrintTaskSnapshot: m.task }));
vi.mock("../../src/integrations/orca-local-enrollment.js", () => ({ readOrcaTaskEnrollment: m.enrollment }));
vi.mock("../../src/integrations/orca-project-policy.js", () => ({ inspectOrcaProjectPolicyPaths: m.policy }));
vi.mock("../../src/integrations/orca-tests.js", () => ({ fingerprintOrcaWorkspace: m.workspace }));
import { inspectOrcaPermissionPreflight } from "../../src/integrations/orca-permission-preflight.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
const h = "a".repeat(64), operator = { namespace: "agenthub-local-operator-v1", subject: "synthetic" };
const binding = { agenthubTaskId: "task", projectId: "project", revision: "4", generation: 1, runtimeId: "runtime", hostId: "local",
  runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/workspace",
  terminalHandle: "terminal", developer: "codex", reviewer: "gemini", provider: "codex", ownerId: "codex", claimId: null };
const task = { id: "task", projectId: "project", revision: 4, status: "DOING", ownerType: "AGENT", owner: "codex", ownerId: "codex", reviewer: "gemini", orcaBinding: binding };
const subjects = { taskId: "task", projectId: "project", generation: 1, bindingDigest: parseOrcaCompletionBinding(JSON.stringify(binding)).digest,
  runtimeId: "runtime", runId: "run", orcaTaskId: "orca-task", dispatchId: "dispatch", terminalHandle: "terminal",
  workerIncarnation: "11111111-1111-4111-8111-111111111111", resourceId: "resource", taskRevision: 4,
  questionId: "msg_111111111111", policySha256: h, workspaceHash: h };
const bytes = Buffer.from(JSON.stringify({ version: 1, purpose: "TASK_SCOPED_ORCA_EXECUTION_PERMISSION",
  approvedAt: "2020-01-01T00:00:00.000Z", operator, sourceAuthenticated: false, subjects }));
const expected = { permissionSha256: createHash("sha256").update(bytes).digest("hex"), enrollmentDigest: h, operator,
  questionId: subjects.questionId, policySha256: h, workspaceHash: h, workerIncarnation: subjects.workerIncarnation, resourceId: "resource", taskRevision: 4 };
const run = () => inspectOrcaPermissionPreflight("/store", "/sessions", "task", "synthetic-policy", bytes, expected);
beforeEach(() => {
  vi.resetAllMocks(); m.task.mockImplementation(() => structuredClone(task));
  m.enrollment.mockImplementation(() => ({ digest: h, operator: structuredClone(operator) }));
  m.policy.mockResolvedValue({ policy: { projectId: "project", workspace: "/workspace", developer: "codex", reviewer: "gemini" } });
  m.workspace.mockResolvedValue(h);
});
it("composes synthetic dependencies without installing or granting permission", async () => {
  expect(await run()).toMatchObject({ localPreflightPassed: true, canReply: false, durablePermissionVerified: false, permissionIssued: false });
});
it.each([{ status: "DONE" }, { revision: 5 }, { owner: "gemini" }, { reviewer: "codex" }, { orcaPrintTaskCompletion: {} }])(
  "rejects changed task scope: %j", async patch => { m.task.mockReturnValue({ ...task, ...patch }); await expect(run()).rejects.toThrow(); });
it.each(["task", "enrollment"])("rejects %s drift during await", async key => {
  m.workspace.mockImplementation(async () => {
    if (key === "task") m.task.mockReturnValue({ ...task, revision: 5 });
    else m.enrollment.mockReturnValue({ digest: "b".repeat(64), operator });
    return h;
  });
  await expect(run()).rejects.toThrow("EXECUTION_PERMISSION_PREFLIGHT_FAILED");
});
it("rejects workspace, enrollment and policy mismatches", async () => {
  m.workspace.mockResolvedValue("b".repeat(64)); await expect(run()).rejects.toThrow(); m.workspace.mockResolvedValue(h);
  m.enrollment.mockReturnValue({ digest: h, operator: { ...operator, subject: "other" } }); await expect(run()).rejects.toThrow();
  m.enrollment.mockReturnValue({ digest: h, operator }); m.policy.mockResolvedValue({ policy: { projectId: "other" } }); await expect(run()).rejects.toThrow();
});
