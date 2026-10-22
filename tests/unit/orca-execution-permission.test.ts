import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { inspectOrcaExecutionPermission } from "../../src/integrations/orca-execution-permission.js";
const binding = { agenthubTaskId: "task", projectId: "project", revision: "4", generation: 1, runtimeId: "runtime", hostId: "local",
  runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/workspace",
  terminalHandle: "terminal", developer: "codex", reviewer: "gemini", provider: "codex", ownerId: "codex", claimId: null };
const raw = JSON.stringify(binding), h = "a".repeat(64), operator = { namespace: "agenthub-local-operator-v1", subject: "synthetic" };
const subjects = { taskId: "task", projectId: "project", generation: 1, bindingDigest: parseOrcaCompletionBinding(raw).digest,
  runtimeId: "runtime", runId: "run", orcaTaskId: "orca-task", dispatchId: "dispatch", terminalHandle: "terminal",
  questionId: "msg_111111111111", policySha256: h, workspaceHash: h, taskRevision: 4,
  workerIncarnation: "11111111-1111-4111-8111-111111111111", resourceId: "resource" };
const record = () => ({ version: 1, purpose: "TASK_SCOPED_ORCA_EXECUTION_PERMISSION", approvedAt: "2020-01-01T00:00:00.000Z",
  operator, sourceAuthenticated: false, subjects: { ...subjects } });
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const expectation = (b: Buffer) => ({ permissionSha256: hash(b), questionId: subjects.questionId, policySha256: h, workspaceHash: h, operator,
  workerIncarnation: subjects.workerIncarnation, resourceId: subjects.resourceId, taskRevision: subjects.taskRevision });
it("binds synthetic supplied bytes without issuing or proving durable permission", () => {
  const b = encode(record()); expect(inspectOrcaExecutionPermission(raw, b, expectation(b))).toMatchObject({
    permissionEvidenceConsistent: true, permissionIssued: false, durablePermissionVerified: false, canReply: false, canCompleteTask: false });
});
it.each([{ taskRevision: 3 }, { taskRevision: 0 }, { taskRevision: 1.5 }, { taskRevision: Number.MAX_SAFE_INTEGER },
  { workerIncarnation: subjects.workerIncarnation + "\n" }, { resourceId: "resource\n" }])(
  "rejects invalid expected worker/version scope: %j", patch => {
    const b = encode(record()); expect(() => inspectOrcaExecutionPermission(raw, b, { ...expectation(b), ...patch })).toThrow();
  });
it("rejects an old permission for a new worker incarnation, resource or task revision", () => {
  const b = encode(record());
  for (const patch of [{ workerIncarnation: "22222222-2222-4222-8222-222222222222" }, { resourceId: "new-resource" }, { taskRevision: 5 }])
    expect(() => inspectOrcaExecutionPermission(raw, b, { ...expectation(b), ...patch })).toThrow();
});
it.each(Object.keys(subjects))("rejects a mismatched %s even with recomputed permission hash", key => {
  const r: any = record(); r.subjects[key] = key === "generation" ? 2 : "different";
  const b = encode(r); expect(() => inspectOrcaExecutionPermission(raw, b, expectation(b))).toThrow();
});
it.each(["purpose", "operator", "approvedAt", "sourceAuthenticated", "extra"])("rejects invalid envelope %s", key => {
  const r: any = record(); r[key] = key === "sourceAuthenticated" ? true : "invalid";
  const b = encode(r); expect(() => inspectOrcaExecutionPermission(raw, b, expectation(b))).toThrow();
});
it("rejects stale pin, duplicate JSON, oversize, invalid UTF-8 and non-buffer input", () => {
  const good = encode(record()); expect(() => inspectOrcaExecutionPermission(raw, good, { ...expectation(good), permissionSha256: "0".repeat(64) })).toThrow();
  for (const b of [Buffer.alloc(0), Buffer.alloc(32769), Buffer.from([0xff]), Buffer.from('{"x":1,"x":1}')])
    expect(() => inspectOrcaExecutionPermission(raw, b, expectation(b))).toThrow();
  expect(() => inspectOrcaExecutionPermission(raw, "text" as any, expectation(good))).toThrow();
});
