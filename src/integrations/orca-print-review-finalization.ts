import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type { ProjectStore } from "../projects/project-store.js";
import type { OrcaEvidenceRef } from "./orca-evidence.js";
import { validOrcaEvidenceRef } from "./orca-evidence.js";
import { validatedOrcaCommit, OrcaImportError } from "./orca-import.js";
import { validatedPassedOrcaTests, hashOrcaTestRun } from "./orca-review.js";
import { inspectOrcaFileAttribution } from "./orca-baseline.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { inspectAntigravityPrintSource } from "./antigravity-print-source.js";
import { decodeOrcaPrintResponse, type OrcaPrintResponseFormat } from "./orca-print-response.js";
import { validGeminiPrintModel } from "./antigravity-print-capture.js";
import type { OrcaPrintCaptureResult } from "./orca-print-review-capture.js";

export const hashOrcaPrintCapture=(capture:OrcaPrintCaptureResult)=>createHash("sha256").update(JSON.stringify(capture)).digest("hex");
export interface OrcaPrintReviewFinalization {
  version:1; adapter:"antigravity-print"; requestId:string; reviewId:string;
  captureHash:string; finalizedRevision:number; finalizedAt:string;
  verdict:"PASS"|"REQUEST_CHANGES"; response:OrcaEvidenceRef; workspaceHash:string;
  sourceAuthenticated:false; canCompleteTask:false;
  responseFormat?:OrcaPrintResponseFormat;
}
interface PrintFinalizationApproval {revision:number;requestId:string;captureHash:string;responseFormat?:OrcaPrintResponseFormat}
const fail=(code:string):never=>{throw new OrcaImportError(code);};
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");

/** Review result only. Does not widen existing acceptance or grant task DONE. */
export async function finalizeOrcaPrintReview(store:ProjectStore,taskId:string,
  approval:PrintFinalizationApproval):Promise<OrcaPrintReviewFinalization> {
  return finalize(store,taskId,approval,false);
}
export async function finalizeOrcaPrintRecovery(store:ProjectStore,taskId:string,
  approval:PrintFinalizationApproval):Promise<OrcaPrintReviewFinalization> {
  return finalize(store,taskId,approval,true);
}
async function finalize(store:ProjectStore,taskId:string,
  approval:PrintFinalizationApproval,recovery:boolean):Promise<OrcaPrintReviewFinalization> {
  const a=structuredClone(approval);
  const format=a.responseFormat===undefined?"raw-json-v1":a.responseFormat;
  if(format!=="raw-json-v1"&&format!=="json-fence-v1")return fail("INVALID_PRINT_RESPONSE_FORMAT");
  if(!Number.isSafeInteger(a.revision)||a.revision<1||a.revision>=Number.MAX_SAFE_INTEGER||typeof a.requestId!=="string"||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(a.requestId)||
      typeof a.captureHash!=="string"||!/^[a-f0-9]{64}(?![\s\S])/.test(a.captureHash))return fail("INVALID_PRINT_FINALIZATION");
  return store.runTaskExecutionExclusive(taskId,async()=> {
    const task=await store.getTask(taskId),commit=validatedOrcaCommit(task),b=task!.orcaBinding!;
    const r=task!.orcaPrintRecoveryPreparation;
    if(recovery&&(!r||task!.orcaPrintCaptureResult?.status!=="FAILED"||task!.orcaPrintReviewFinalization||
        r.previousRequestId!==task!.orcaPrintReviewPreparation?.requestId||hashOrcaPrintCapture(task!.orcaPrintCaptureResult)!==r.failedCaptureHash))return fail("PRINT_RECOVERY_NOT_READY");
    if(!recovery&&r)return fail("PRINT_FINALIZATION_NOT_READY");
    const p=recovery?r?.preparation:task!.orcaPrintReviewPreparation,
      i=recovery?task!.orcaPrintRecoveryCaptureIntent:task!.orcaPrintCaptureIntent,
      c=recovery?task!.orcaPrintRecoveryCaptureResult:task!.orcaPrintCaptureResult,
      old=recovery?task!.orcaPrintRecoveryFinalization:task!.orcaPrintReviewFinalization;
    if(!p||!i||!c||task!.status!=="REVIEW"||task!.result!==undefined||task!.orcaReviewRun||
        p.requestId!==a.requestId||i.requestId!==p.requestId||c.requestId!==p.requestId||c.status!=="CAPTURED"||
        hashOrcaPrintCapture(c)!==a.captureHash||i.profile?.kind!=="view-file-v1"||!validGeminiPrintModel(i.model)||
        i.requestSha256!==p.request.sha256||i.startedRevision!==p.preparedRevision+1||
        p.subjects.taskId!==taskId||p.subjects.digest!==commit.digest||p.subjects.generation!==commit.generation||
        p.bindingHash!==sha(JSON.stringify(b))||commit.outbox.state!=="PROJECTED"||
        b.developer!=="codex"||b.reviewer!=="gemini"||task!.ownerType!=="AGENT"||task!.owner!==b.developer||task!.ownerId!==b.ownerId||
        (task!.reviewerId??task!.reviewer)!==b.reviewer||(task!.claim?.id??null)!==b.claimId)return fail("PRINT_FINALIZATION_NOT_READY");
    const expectedRevision=i.startedRevision+1;
    if(a.revision!==expectedRevision||task!.revision!==(old?expectedRevision+1:expectedRevision)||
        (old&&(old.captureHash!==a.captureHash||old.requestId!==a.requestId||old.finalizedRevision!==task!.revision||
          (old.responseFormat??"raw-json-v1")!==format)))return fail("STALE_PRINT_FINALIZATION");
    const tests=validatedPassedOrcaTests(task!);
    if(hashOrcaTestRun(tests)!==p.subjects.testRunHash||tests.id!==p.subjects.testRunId||tests.workspaceHash!==p.subjects.workspaceHash)return fail("STALE_TEST_RECEIPT");
    for(const ref of [p.requirements,p.testOutput,p.baseline]){
      if(!validOrcaEvidenceRef(ref)||ref.bytes>65536)return fail("INVALID_PRINT_EVIDENCE");await store.readOrcaEvidence(ref);
    }
    const bytes={} as Record<keyof OrcaPrintCaptureResult["files"],Buffer>;
    const budgets={request:65536,intent:32768,stdout:4194304,stderr:65536,process:32768};
    for(const key of ["request","intent","stdout","stderr","process"] as const){
      const ref=c.files[key];if(!validOrcaEvidenceRef(ref)||ref.bytes>budgets[key])return fail("INVALID_PRINT_EVIDENCE");
      bytes[key]=await store.readOrcaEvidence(ref);
    }
    if(!isDeepStrictEqual(c.files.request,p.request))return fail("PRINT_REQUEST_CHANGED");
    const source=inspectAntigravityPrintSource(bytes.request,bytes.intent,bytes.stdout,bytes.stderr,bytes.process,
      JSON.stringify({requestId:p.requestId,cwd:b.workspacePath,executable:i.executable,requestSha256:p.request.sha256,profile:i.profile,model:i.model}));
    const parsed=decodeOrcaPrintResponse(source.response,format),answer=parsed.ok?parsed.value as any:null;
    if(!answer||typeof answer!=="object"||Array.isArray(answer)||
        Object.keys(answer).sort().join(",")!==[...Object.keys(p.subjects),"verdict"].sort().join(",")||
        Object.entries(p.subjects).some(([key,value])=>answer[key]!==value)||!["PASS","REQUEST_CHANGES"].includes(answer.verdict))return fail("INVALID_PRINT_REVIEW_RESPONSE");
    const attribution=await inspectOrcaFileAttribution(store,taskId);
    if(!attribution.withinWhitelist||attribution.workspaceHash!==p.subjects.workspaceHash||
        !isDeepStrictEqual(i.profile.allowedPaths,attribution.changedFiles.map(file=>path.join(b.workspacePath,file)).sort()))return fail("PRINT_FINALIZATION_WORKSPACE_CHANGED");
    const response=await store.putOrcaEvidence(Buffer.from(source.response));
    if(await fingerprintOrcaWorkspace(b.workspacePath)!==p.subjects.workspaceHash||!isDeepStrictEqual(await store.getTask(taskId),task))return fail("PRINT_FINALIZATION_SNAPSHOT_CHANGED");
    if(old){
      if(old.verdict!==answer.verdict||old.reviewId!==p.subjects.reviewId||!isDeepStrictEqual(old.response,response)||old.workspaceHash!==p.subjects.workspaceHash)
        return fail("PRINT_FINALIZATION_REPLAY_CONFLICT");
      return structuredClone(old);
    }
    const result:OrcaPrintReviewFinalization={version:1,adapter:"antigravity-print",requestId:p.requestId,reviewId:p.subjects.reviewId,
      captureHash:a.captureHash,finalizedRevision:a.revision+1,finalizedAt:new Date().toISOString(),verdict:answer.verdict,response,
      workspaceHash:p.subjects.workspaceHash,sourceAuthenticated:false,canCompleteTask:false,responseFormat:format};
    if(recovery)task!.orcaPrintRecoveryFinalization=result;
    else task!.orcaPrintReviewFinalization=result;
    task!.updatedAt=result.finalizedAt;
    task!.nextAction="Independent print review recorded; separate acceptance/completion policy still required";
    await store.saveTask(task!);return structuredClone(result);
  });
}
