import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

const fail = (): never => { throw Error("INVALID_EXECUTION_PERMISSION_EVIDENCE"); };
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v);
export interface OrcaExecutionPermissionExpectation {
  permissionSha256: string; questionId: string; policySha256: string; workspaceHash: string;
  workerIncarnation: string; resourceId: string; taskRevision: number;
  operator: { namespace: string; subject: string };
}
/** Supplied permission bytes only. Does not issue permission, reply, or authenticate its producer. */
export function inspectOrcaExecutionPermission(rawBinding: string, bytes: Buffer, expected: OrcaExecutionPermissionExpectation) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 32768 ||
      !expected || typeof expected !== "object" || Array.isArray(expected) ||
      Object.keys(expected).sort().join(",") !== "operator,permissionSha256,policySha256,questionId,resourceId,taskRevision,workerIncarnation,workspaceHash") return fail();
  const e = structuredClone(expected);
  if (![e.permissionSha256, e.policySha256, e.workspaceHash].every(digest) ||
      typeof e.questionId !== "string" || !/^msg_[a-f0-9]{12}(?![\s\S])/.test(e.questionId) ||
      !Number.isSafeInteger(e.taskRevision) || e.taskRevision < 1 || e.taskRevision > Number.MAX_SAFE_INTEGER - 2 ||
      typeof e.workerIncarnation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(e.workerIncarnation) ||
      typeof e.resourceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}(?![\s\S])/.test(e.resourceId) ||
      !e.operator || Object.keys(e.operator).sort().join(",") !== "namespace,subject" ||
      e.operator.namespace !== "agenthub-local-operator-v1" || typeof e.operator.subject !== "string" ||
      e.operator.subject.length < 1 || e.operator.subject.length > 256) return fail();
  const { binding: b, digest: bindingDigest } = parseOrcaCompletionBinding(rawBinding);
  if (b.hostId !== "local" || e.taskRevision < Number(b.revision) ||
      createHash("sha256").update(bytes).digest("hex") !== e.permissionSha256) return fail();
  const decoded = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const p = decoded.ok ? decoded.value as any : null;
  const subjects = { taskId: b.agenthubTaskId, projectId: b.projectId, generation: b.generation, bindingDigest,
    runtimeId: b.runtimeId, runId: b.runId, orcaTaskId: b.taskId, dispatchId: b.dispatchId,
    terminalHandle: b.terminalHandle, workerIncarnation: e.workerIncarnation, resourceId: e.resourceId,
    taskRevision: e.taskRevision, questionId: e.questionId, policySha256: e.policySha256, workspaceHash: e.workspaceHash };
  if (!p || Object.keys(p).sort().join(",") !== "approvedAt,operator,purpose,sourceAuthenticated,subjects,version" ||
      p.version !== 1 || p.purpose !== "TASK_SCOPED_ORCA_EXECUTION_PERMISSION" || p.sourceAuthenticated !== false ||
      !isDeepStrictEqual(p.operator, e.operator) || !isDeepStrictEqual(p.subjects, subjects) ||
      typeof p.approvedAt !== "string" || !Number.isFinite(Date.parse(p.approvedAt)) ||
      new Date(p.approvedAt).toISOString() !== p.approvedAt || Date.parse(p.approvedAt) > Date.now()) return fail();
  return { permissionSha256: e.permissionSha256, bindingDigest, questionId: e.questionId,
    permissionEvidenceConsistent: true, permissionIssued: false, operatorAuthenticated: false,
    durablePermissionVerified: false, replyDeliveryVerified: false, canReply: false, canReleaseWorker: false,
    canCompleteTask: false, sourceAuthenticated: false, scope: "SUPPLIED_EXECUTION_PERMISSION_ONLY" };
}
