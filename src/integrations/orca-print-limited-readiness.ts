import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inspectOrcaPrintCompletionReadiness,readOrcaPrintTaskSnapshot } from "./orca-print-completion-readiness.js";
import { readOrcaTaskEnrollment } from "./orca-local-enrollment.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { inspectOrcaRetainedTerminalEvidence } from "./orca-retained-terminal.js";

const fail=():never=>{throw Error("PRINT_LIMITED_READINESS_FAILED");};
/** Composes local checks into draft approval subjects, never issues approval. */
export async function inspectOrcaPrintLimitedReadiness(projectRoot:string,sessionsRoot:string,taskId:string,
  expectation:{revision:number;attempt:"initial"|"recovery";finalizationHash:string;enrollmentDigest:string;
    settlementSha256:string;releaseSha256:string;workerIncarnation:string},settlement:Buffer,release:Buffer){
  if(typeof taskId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(taskId)||
      !Buffer.isBuffer(settlement)||!Buffer.isBuffer(release)||settlement.length>262144||release.length>262144)return fail();
  const e=structuredClone(expectation),s=Buffer.from(settlement),r=Buffer.from(release);
  if(typeof e.enrollmentDigest!=="string"||!/^[a-f0-9]{64}(?![\s\S])/.test(e.enrollmentDigest))return fail();
  const task=readOrcaPrintTaskSnapshot(projectRoot,taskId);
  const {binding,digest}=parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding));
  const scope={taskId,projectId:binding.projectId,generation:binding.generation,bindingDigest:digest};
  const enrollment=readOrcaTaskEnrollment(projectRoot,sessionsRoot,scope);
  if(enrollment.digest!==e.enrollmentDigest||binding.agenthubTaskId!==taskId||task.projectId!==binding.projectId)return fail();
  const retained=inspectOrcaRetainedTerminalEvidence(JSON.stringify(binding),s,r,{settlementSha256:e.settlementSha256,
    releaseSha256:e.releaseSha256,workerIncarnation:e.workerIncarnation});
  const review=await inspectOrcaPrintCompletionReadiness(projectRoot,taskId,{revision:e.revision,attempt:e.attempt,finalizationHash:e.finalizationHash});
  if(!isDeepStrictEqual(readOrcaTaskEnrollment(projectRoot,sessionsRoot,scope),enrollment)||
      !isDeepStrictEqual(readOrcaPrintTaskSnapshot(projectRoot,taskId),task))return fail();
  return {taskId,revision:e.revision,localChecksPassed:true,approvalIssued:false,retainedTerminalExceptionApproved:false,
    sourceAuthenticated:false,canCompleteTask:false,scope:"DRAFT_PRINT_LIMITED_COMPLETION_SUBJECTS",
    subjects:{...review.subjects,bindingDigest:digest,enrollmentDigest:enrollment.digest,operator:enrollment.operator,
      originalTaskDigest:createHash("sha256").update(JSON.stringify(task)).digest("hex"),
      settlementSha256:e.settlementSha256,releaseSha256:e.releaseSha256,workerIncarnation:e.workerIncarnation,resourceId:retained.resourceId},
    proposedRetainedGaps:["USER_OWNED_RETAINED_TERMINAL","SOURCE_NOT_AUTHENTICATED","HISTORICAL_LIFECYCLE_ONLY"],
    blockers:["EXACT_TASK_SCOPED_LIMITED_COMPLETION_APPROVAL_ABSENT","PRINT_COMPLETION_TRANSACTION_NOT_IMPLEMENTED"]};
}
