import { isDeepStrictEqual } from "node:util";
import { readOrcaPrintTaskSnapshot } from "./orca-print-completion-readiness.js";
import { readOrcaTaskEnrollment } from "./orca-local-enrollment.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { inspectOrcaProjectPolicyPaths } from "./orca-project-policy.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { inspectOrcaExecutionPermission, type OrcaExecutionPermissionExpectation } from "./orca-execution-permission.js";

const fail = (): never => { throw Error("EXECUTION_PERMISSION_PREFLIGHT_FAILED"); };
/** Local read-only checks, not fresh worker/question observation or permission installation. */
export async function inspectOrcaPermissionPreflight(root: string, sessions: string, taskId: string,
  rawPolicy: string, permission: Buffer, expected: OrcaExecutionPermissionExpectation & { enrollmentDigest: string }) {
  if (!Buffer.isBuffer(permission) || permission.length < 1 || permission.length > 32768 ||
      !expected || typeof expected !== "object" || Array.isArray(expected) ||
      Object.keys(expected).sort().join(",") !== "enrollmentDigest,operator,permissionSha256,policySha256,questionId,resourceId,taskRevision,workerIncarnation,workspaceHash" ||
      typeof expected.enrollmentDigest !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(expected.enrollmentDigest)) return fail();
  const e = structuredClone(expected), bytes = Buffer.from(permission);
  const task = readOrcaPrintTaskSnapshot(root, taskId);
  const rawBinding = JSON.stringify(task.orcaBinding), { binding: b, digest } = parseOrcaCompletionBinding(rawBinding);
  const { enrollmentDigest, ...permissionExpected } = e;
  const checked = inspectOrcaExecutionPermission(rawBinding, bytes, permissionExpected);
  if (task.id !== taskId || b.agenthubTaskId !== taskId || task.projectId !== b.projectId || task.revision !== e.taskRevision ||
      task.status !== "DOING" || task.result !== undefined || task.orcaCompletion || task.orcaTaskCompletion || task.orcaPrintTaskCompletion ||
      task.ownerType !== "AGENT" || task.owner !== b.developer || task.ownerId !== b.ownerId ||
      (task.reviewerId ?? task.reviewer) !== b.reviewer || (task.claim?.id ?? null) !== b.claimId ||
      (task.claim && task.claim.ownerId !== b.ownerId)) return fail();
  const scope = { taskId, projectId: b.projectId, generation: b.generation, bindingDigest: digest };
  const enrollment = readOrcaTaskEnrollment(root, sessions, scope);
  if (enrollment.digest !== enrollmentDigest || !isDeepStrictEqual(enrollment.operator, e.operator)) return fail();
  const { policy } = await inspectOrcaProjectPolicyPaths(rawPolicy, e.policySha256);
  if (policy.projectId !== b.projectId || policy.workspace !== b.workspacePath ||
      policy.developer !== b.developer || policy.reviewer !== b.reviewer) return fail();
  if (await fingerprintOrcaWorkspace(b.workspacePath) !== e.workspaceHash) return fail();
  if (!isDeepStrictEqual(readOrcaTaskEnrollment(root, sessions, scope), enrollment) ||
      !isDeepStrictEqual(readOrcaPrintTaskSnapshot(root, taskId), task)) return fail();
  return { ...checked, taskId, taskRevision: task.revision, enrollmentDigest, localPreflightPassed: true,
    scope: "LOCAL_EXECUTION_PERMISSION_PREFLIGHT_ONLY", blockers: ["FRESH_WORKER_AND_QUESTION_NOT_VERIFIED",
      "EXACT_HUMAN_EXECUTION_APPROVAL_NOT_VERIFIED", "REVOCATION_AND_EXPIRY_NOT_VERIFIED", "PERMISSION_NOT_INSTALLED"] };
}
