import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inspectOrcaPrintCompletionReadiness, readOrcaPrintTaskSnapshot } from "./orca-print-completion-readiness.js";
import { readOrcaTaskEnrollment } from "./orca-local-enrollment.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { inspectOrcaManagedReleaseEvidence } from "./orca-managed-terminal.js";
import { parseOrcaManagedDraftSubjects } from "./orca-managed-subjects.js";

export interface OrcaPrintManagedExpectation {
  revision: number; attempt: "initial" | "recovery"; finalizationHash: string; enrollmentDigest: string;
  settlementSha256: string; releaseSha256: string; workerIncarnation: string; resourceId: string;
}
const fail = (): never => { throw Error("PRINT_MANAGED_READINESS_FAILED"); };
/** Local draft only. No release, approval, task writer or scheduler is installed. */
export async function inspectOrcaPrintManagedReadiness(projectRoot: string, sessionsRoot: string, taskId: string,
  expectation: OrcaPrintManagedExpectation, settlement: Buffer, release: Buffer) {
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation) ||
      Object.keys(expectation).sort().join(",") !== "attempt,enrollmentDigest,finalizationHash,releaseSha256,resourceId,revision,settlementSha256,workerIncarnation" ||
      typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(taskId) ||
      !Buffer.isBuffer(settlement) || !Buffer.isBuffer(release) || !settlement.length || !release.length ||
      settlement.length > 262144 || release.length > 262144) return fail();
  const e = structuredClone(expectation), s = Buffer.from(settlement), r = Buffer.from(release);
  if (!Number.isSafeInteger(e.revision) || e.revision < 1 || !["initial", "recovery"].includes(e.attempt) ||
      [e.enrollmentDigest, e.finalizationHash, e.settlementSha256, e.releaseSha256].some(value =>
        typeof value !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(value)) ||
      typeof e.workerIncarnation !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(e.workerIncarnation) ||
      typeof e.resourceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}(?![\s\S])/.test(e.resourceId)) return fail();
  const task = readOrcaPrintTaskSnapshot(projectRoot, taskId);
  if (task.orcaPrintTaskCompletion || task.orcaTaskCompletion || task.orcaCompletion) return fail();
  const { binding, digest } = parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding));
  const scope = { taskId, projectId: binding.projectId, generation: binding.generation, bindingDigest: digest };
  const enrollment = readOrcaTaskEnrollment(projectRoot, sessionsRoot, scope);
  if (enrollment.digest !== e.enrollmentDigest || binding.agenthubTaskId !== taskId || task.projectId !== binding.projectId) return fail();
  const managed = inspectOrcaManagedReleaseEvidence(JSON.stringify(binding), s, r,
    { settlementSha256: e.settlementSha256, releaseSha256: e.releaseSha256, workerIncarnation: e.workerIncarnation, resourceId: e.resourceId });
  const review = await inspectOrcaPrintCompletionReadiness(projectRoot, taskId,
    { revision: e.revision, attempt: e.attempt, finalizationHash: e.finalizationHash });
  const subjects = { ...review.subjects, attempt: e.attempt, bindingDigest: digest, enrollmentDigest: enrollment.digest,
    operator: enrollment.operator, originalTaskDigest: createHash("sha256").update(JSON.stringify(task)).digest("hex"),
    settlementSha256: e.settlementSha256, releaseSha256: e.releaseSha256,
    workerIncarnation: e.workerIncarnation, resourceId: managed.resourceId };
  parseOrcaManagedDraftSubjects(Buffer.from(JSON.stringify(subjects)));
  if (!isDeepStrictEqual(readOrcaTaskEnrollment(projectRoot, sessionsRoot, scope), enrollment) ||
      !isDeepStrictEqual(readOrcaPrintTaskSnapshot(projectRoot, taskId), task)) return fail();
  return { taskId, revision: e.revision, localChecksPassed: true, approvalIssued: false, canReleaseWorker: false,
    canCompleteTask: false, sourceAuthenticated: false, globalGateApproved: false,
    scope: "DRAFT_PRINT_MANAGED_COMPLETION_SUBJECTS",
    subjects,
    blockers: ["EXECUTION_PERMISSION_AND_LIFECYCLE_CHRONOLOGY_NOT_CHECKED", "SOURCE_AUTHENTICATION_NOT_VERIFIED",
      "ARCHIVE_CONTENT_NOT_VERIFIED", "EXACT_MANAGED_COMPLETION_APPROVAL_ABSENT", "MANAGED_COMPLETION_TRANSACTION_NOT_IMPLEMENTED"] };
}
