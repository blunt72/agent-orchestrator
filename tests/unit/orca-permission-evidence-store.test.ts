import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { persistOrcaPermissionEvidence } from "../../src/integrations/orca-permission-evidence-store.js";
let directory: string;
beforeEach(() => { directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "permission-evidence-"))); fs.chmodSync(directory, 0o700); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const binding = { agenthubTaskId: "task", projectId: "project", revision: "4", generation: 1, runtimeId: "runtime", hostId: "local",
  runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/workspace",
  terminalHandle: "terminal", developer: "codex", reviewer: "gemini", provider: "codex", ownerId: "codex", claimId: null };
const rawBinding = JSON.stringify(binding), h = "a".repeat(64), operator = { namespace: "agenthub-local-operator-v1", subject: "synthetic" };
function fixture(revision = 4) {
  const subjects = { taskId: "task", projectId: "project", generation: 1, bindingDigest: parseOrcaCompletionBinding(rawBinding).digest,
    runtimeId: "runtime", runId: "run", orcaTaskId: "orca-task", dispatchId: "dispatch", terminalHandle: "terminal",
    workerIncarnation: "11111111-1111-4111-8111-111111111111", resourceId: "resource", taskRevision: revision,
    questionId: "msg_111111111111", policySha256: h, workspaceHash: h };
  const bytes = Buffer.from(JSON.stringify({ version: 1, purpose: "TASK_SCOPED_ORCA_EXECUTION_PERMISSION",
    approvedAt: "2020-01-01T00:00:00.000Z", operator, sourceAuthenticated: false, subjects }));
  const expected = { permissionSha256: createHash("sha256").update(bytes).digest("hex"), questionId: subjects.questionId,
    policySha256: h, workspaceHash: h, operator, workerIncarnation: subjects.workerIncarnation, resourceId: subjects.resourceId, taskRevision: revision };
  return { bytes, expected };
}
function store(revision = 4) { const f = fixture(revision); return persistOrcaPermissionEvidence(directory, rawBinding, f.bytes, f.expected); }
it("stores synthetic immutable evidence and recognizes exact replay without installing permission", () => {
  const first = store(); const inode = fs.statSync(first.file).ino;
  expect(first).toMatchObject({ evidenceStored: true, replay: false, durablePermissionVerified: false, canReply: false });
  expect(store()).toMatchObject({ replay: true }); expect(fs.statSync(first.file).ino).toBe(inode);
  expect(fs.readdirSync(directory)).toEqual(["task.permission-evidence-v1.json"]);
});
it("refuses different valid bytes for the same task and preserves the first record", () => {
  const first = store(), bytes = fs.readFileSync(first.file);
  expect(() => store(5)).toThrow("PERMISSION_EVIDENCE_STORE_CONFLICT");
  expect(fs.readFileSync(first.file)).toEqual(bytes);
});
it("rejects unsafe directory and missing storage without creating it", () => {
  fs.chmodSync(directory, 0o755); expect(store).toThrow();
  fs.rmSync(directory, { recursive: true }); expect(store).toThrow(); expect(fs.existsSync(directory)).toBe(false);
});
it("rejects malformed evidence before writing", () => {
  const f = fixture(); expect(() => persistOrcaPermissionEvidence(directory, rawBinding, Buffer.alloc(32769), f.expected)).toThrow();
  expect(() => persistOrcaPermissionEvidence(directory, rawBinding, f.bytes, { ...f.expected, permissionSha256: "0".repeat(64) })).toThrow();
  expect(fs.readdirSync(directory)).toEqual([]);
});
