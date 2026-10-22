import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {OrcaReadOnlyStore} from "./orca-read-only-store.js";
import {readOrcaTaskEnrollment} from "./orca-local-enrollment.js";
import {parseOrcaCompletionBinding} from "./orca-evidence-manifest.js";
import {inspectOrcaAcceptance,hashOrcaReviewRun} from "./orca-acceptance.js";
import {hashOrcaTestRun} from "./orca-review.js";
import {inspectOrcaFileAttribution} from "./orca-baseline.js";
import {inspectOrcaLimitedExceptions} from "./orca-limited-exceptions.js";
import {validOrcaEvidenceRef,type OrcaEvidenceRef} from "./orca-evidence.js";
import {decodeOrcaJson} from "./orca-json.js";
import {GitService} from "../git/git-service.js";
import {fingerprintOrcaWorkspace} from "./orca-tests.js";
import {planOrcaDelivery,type OrcaBinding} from "./orca-delivery.js";
import type {FileBaselineEntry} from "../git/git-service.js";
import type {Task} from "../tasks/task.js";

const roles=["startup","binding","bindingOutput","workerDone","settlement","testOutput","reviewResponse","cleanup"] as const;
const fail=():never=>{throw new Error("INVALID_LIMITED_READINESS_EVIDENCE");};
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
export function validateLimitedRetainedDelivery(binding:OrcaBinding,message:unknown,settlement:unknown,expectedDigest:string){
 const plan=planOrcaDelivery(binding,{taskId:binding.agenthubTaskId,projectId:binding.projectId,revision:binding.revision,
  generation:binding.generation,status:"DOING",ownerId:binding.ownerId,claimId:binding.claimId,reviewerId:binding.reviewer},message,settlement);
 if(plan.kind!=="candidate"||plan.digest!==expectedDigest)return fail();
}
export function validateLimitedMetadataSnapshot(head:string,files:Record<string,FileBaselineEntry>,expectedHash:string){
 if(!/^[a-f0-9]{40,64}(?![\s\S])/.test(head)||sha(JSON.stringify({head,files:Object.keys(files).sort().map(name=>[name,files[name]])}))!==expectedHash)return fail();
}
function parse(bytes:Buffer){
 if(bytes.length>262144)return fail();
 const d=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
 if(!d.ok)return fail();return d.value as any;
}
function unwrap(bytes:Buffer){const w=parse(bytes);if(w?.exit_code!==0||typeof w.output!=="string")return fail();return parse(Buffer.from(w.output));}

/** Explicit exception-aware PREPARATION only. Does not replace strict completion admission. */
export async function inspectOrcaLimitedReadiness(root:string,sessions:string,taskId:string,
 rawBundle:string,bundleDigest:string,rawPolicy:string,policyDigest:string,original?:Task){
 if(typeof rawBundle!=="string"||Buffer.byteLength(rawBundle)>32768||sha(rawBundle)!==bundleDigest)return fail();
 const bundle=parse(Buffer.from(rawBundle));
 if(!bundle||Object.keys(bundle).sort().join(",")!=="bindingDigest,entries,taskId,version"||bundle.version!==1||bundle.taskId!==taskId||
   !bundle.entries||Object.keys(bundle.entries).sort().join(",")!==[...roles].sort().join(",")||
   !roles.every(role=>validOrcaEvidenceRef(bundle.entries[role])))return fail();
 const liveStore=new OrcaReadOnlyStore(root),liveBefore=await liveStore.getTask(taskId);
 const frozen=original?structuredClone(original):undefined;
 const store=frozen?{getTask:async(id:string)=>id===taskId?structuredClone(frozen):null,
  readOrcaEvidence:liveStore.readOrcaEvidence.bind(liveStore),verifyTaskEventReadOnly:liveStore.verifyTaskEventReadOnly.bind(liveStore)}:liveStore;
 const task=await store.getTask(taskId);
 if(!task?.orcaBinding||!task.orcaTestRun||!task.orcaReviewRun||!task.orcaBaseline)return fail();
 const bound=parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding)),b=bound.binding;
 if(bundle.bindingDigest!==bound.digest)return fail();
 const scope={taskId,projectId:b.projectId,generation:b.generation,bindingDigest:bound.digest};
 const enrollment=readOrcaTaskEnrollment(root,sessions,scope);
 const acceptance=await inspectOrcaAcceptance(store,taskId,{revision:task.revision!,generation:b.generation,digest:task.orcaDelivery!.digest,
  workspaceHash:task.orcaTestRun.workspaceHash,testRunHash:hashOrcaTestRun(task.orcaTestRun),reviewRunHash:hashOrcaReviewRun(task.orcaReviewRun)});
 const bytes={} as Record<typeof roles[number],Buffer>;
 for(const role of roles)bytes[role]=await store.readOrcaEvidence(bundle.entries[role] as OrcaEvidenceRef);
 if(!isDeepStrictEqual(bundle.entries.testOutput,task.orcaTestRun.outputEvidence)||
    !isDeepStrictEqual(bundle.entries.reviewResponse,task.orcaReviewRun.responseEvidence)||
    !isDeepStrictEqual(bundle.entries.cleanup,bundle.entries.settlement))return fail();
 const start=parse(bytes.startup),ack=parse(bytes.binding),delivery=unwrap(bytes.workerDone);
 const question=start?.result?.messages?.find((m:any)=>m.id===ack?.questionId);
 if(start?.ok!==true||start?._meta?.runtimeId!==b.runtimeId||!question||question.type!=="question"||
   question.run_id!==b.runId||question.from_handle!==`dispatch:${b.dispatchId}`||question.to_handle!==`run:${b.runId}`||
   ack.taskId!==taskId||ack.revision!==Number(b.revision)||ack.generation!==b.generation||ack.claimId!==b.claimId||
   ack.bindingDigest!==bound.digest||ack.baselineSha256!==task.orcaBaseline.evidence.sha256||
   ack.workspaceHash!==task.orcaBaseline.workspaceHash||ack.bound!==true||ack.baselineVerified!==true||ack.developmentReleased!==false)return fail();
 const payload=typeof question.payload==="string"?parse(Buffer.from(question.payload)):question.payload;
 if(payload?.taskId!==b.taskId||payload?.dispatchId!==b.dispatchId)return fail();
 // This original tool output is retained as opaque bytes; do not strip its trailing prose into JSON.
 const bindingOutput=parse(bytes.bindingOutput);
 if(bindingOutput?.exit_code!==0||typeof bindingOutput.output!=="string")return fail();
 const message=delivery?.result?.messages?.find((m:any)=>m.id===task.orcaDelivery!.messageId);
 if(delivery?.ok!==true||delivery?._meta?.runtimeId!==b.runtimeId||!message||message.type!=="worker_done"||
   message.run_id!==b.runId||message.from_handle!==b.terminalHandle||message.to_handle!==`run:${b.runId}`)return fail();
 const result=typeof message.payload==="string"?parse(Buffer.from(message.payload)):message.payload;
 if(result?.taskId!==b.taskId||result?.dispatchId!==b.dispatchId||result?.outcome!=="succeeded")return fail();
 validateLimitedRetainedDelivery(b,message,unwrap(bytes.settlement),task.orcaDelivery!.digest);
 const attribution=await inspectOrcaFileAttribution(store,taskId),files=await GitService.captureBaseline(b.workspacePath);
 if(attribution.workspaceHash!==task.orcaTestRun.workspaceHash)return fail();
 const head=await GitService.exec(["rev-parse","--verify","HEAD"],b.workspacePath);
 if(head.exitCode!==0)return fail();
 validateLimitedMetadataSnapshot(head.stdout,files,attribution.workspaceHash);
 const exceptions=inspectOrcaLimitedExceptions(rawPolicy,policyDigest,JSON.stringify(b),{
  revision:task.revision!,workspaceHash:attribution.workspaceHash,outsideWhitelist:attribution.outsideWhitelist,metadata:files[".DS_Store"]},bytes.cleanup);
 const baseline=parse(await store.readOrcaEvidence(task.orcaBaseline.evidence));
 if(await fingerprintOrcaWorkspace(b.workspacePath)!==task.orcaTestRun.workspaceHash||!isDeepStrictEqual(await store.getTask(taskId),task)||
   (original!==undefined&&!isDeepStrictEqual(await liveStore.getTask(taskId),liveBefore))||
   !isDeepStrictEqual(readOrcaTaskEnrollment(root,sessions,scope),enrollment))return fail();
 return {taskId,revision:task.revision!,allowedFiles:baseline.allowedFiles as string[],changedFiles:[...attribution.changedFiles],acceptance,enrollmentDigest:enrollment.digest,bundleDigest,policyDigest,exceptions,
  retainedEvidenceConsistent:true as const,approvalIssued:false as const,canCompleteTask:false as const,sourceAuthenticated:false as const,
  scope:"LIMITED_HUMAN_ACCEPTANCE_PREPARATION" as const,
  blockers:["INDEPENDENT_IMPLEMENTATION_REVIEW_REQUIRED","EXACT_FINAL_HUMAN_APPROVAL_REQUIRED","WRITEBACK_NOT_INTEGRATED"]};
}
