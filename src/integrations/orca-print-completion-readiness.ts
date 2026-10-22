import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { Task } from "../tasks/task.js";
import { OrcaReadOnlyStore } from "./orca-read-only-store.js";
import { decodeOrcaJson } from "./orca-json.js";
import { validatedOrcaCommit } from "./orca-import.js";
import { hashOrcaTestRun, validatedPassedOrcaTests } from "./orca-review.js";
import { hashOrcaPrintCapture } from "./orca-print-review-finalization.js";
import { validGeminiPrintModel } from "./antigravity-print-capture.js";
import { inspectAntigravityPrintSource } from "./antigravity-print-source.js";
import { decodeOrcaPrintResponse } from "./orca-print-response.js";
import { inspectOrcaFileAttribution } from "./orca-baseline.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { validOrcaEvidenceRef } from "./orca-evidence.js";
import { verifyTaskEventBytes, TASK_EVENT_LOG_MAX_BYTES } from "./task-event-store.js";
import type { OrcaPrintReviewPreparation } from "./orca-print-review-preparation.js";

const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=():never=>{throw Error("PRINT_COMPLETION_READINESS_FAILED");};

// Synchronous final task comparison follows all awaited workspace/evidence reads.
function readSnapshotBytes(root:string,segments:string[],max:number):Buffer {
  const directories=[root,...segments.slice(0,-1).map((_,index)=>path.join(root,...segments.slice(0,index+1)))].map(name=>{
    const stat=fs.lstatSync(name,{bigint:true});if(fs.realpathSync(name)!==name||!stat.isDirectory())return fail();return {name,stat};
  });
  const file=path.join(root,...segments),before=fs.lstatSync(file,{bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size>BigInt(max)||before.uid!==BigInt(process.getuid!())||(before.mode&0o022n))return fail();
  const same=(s:typeof before)=>s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mode===before.mode&&
    s.uid===before.uid&&s.nlink===before.nlink&&s.mtimeNs===before.mtimeNs&&s.ctimeNs===before.ctimeNs;
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    if(!same(fs.fstatSync(fd,{bigint:true})))return fail();
    const bytes=Buffer.alloc(Number(before.size)+1);let n=0;
    while(n<bytes.length){const k=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!k)break;n+=k;}
    if(n!==Number(before.size)||!same(fs.fstatSync(fd,{bigint:true}))||!same(fs.lstatSync(file,{bigint:true})))return fail();
    for(const {name,stat} of directories){const now=fs.lstatSync(name,{bigint:true});
      if(!now.isDirectory()||now.dev!==stat.dev||now.ino!==stat.ino||now.mode!==stat.mode||now.uid!==stat.uid||fs.realpathSync(name)!==name)return fail();}
    return bytes.subarray(0,n);
  }finally{fs.closeSync(fd);}
}
function snapshot(root:string,id:string):Task {
  if(typeof root!=="string"||!path.isAbsolute(root)||typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(id))return fail();
  const parsed=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(readSnapshotBytes(root,["data","tasks",`${id}.json`],262144)));
  const task=parsed.ok?parsed.value as Task:null;if(!task||task.id!==id)return fail();return task;
}
export const readOrcaPrintTaskSnapshot=snapshot;
export function readOrcaPrintTaskEventSnapshot(root:string,id:string):Buffer {
  if(typeof root!=="string"||!path.isAbsolute(root)||typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(id))return fail();
  return readSnapshotBytes(root,["logs","tasks",`${id}.jsonl`],TASK_EVENT_LOG_MAX_BYTES);
}
const parse=(bytes:Buffer)=>{const r=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes));return r.ok?r.value as any:null;};
async function reconcileRequest(reader:OrcaReadOnlyStore,task:Task,p:OrcaPrintReviewPreparation,bytes:Buffer){
  const texts:string[]=[];
  for(const ref of [p.requirements,p.testOutput,p.baseline]){
    if(!validOrcaEvidenceRef(ref)||ref.bytes>65536)return fail();texts.push(new TextDecoder("utf-8",{fatal:true}).decode(await reader.readOrcaEvidence(ref)));
  }
  const request=parse(bytes);
  if(request?.requestId!==p.requestId||request.workspace!==task.orcaBinding!.workspacePath||!isDeepStrictEqual(request.expected,p.subjects)||
      !isDeepStrictEqual(request.task,{title:task.title,description:task.description})||request.requirements!==texts[0]||request.testOutput!==texts[1]||request.baseline!==texts[2])return fail();
}

/** Local review evidence only. No enrollment/lifecycle approval or completion write. */
export async function inspectOrcaPrintCompletionReadiness(projectRoot:string,taskId:string,
  expectation:{revision:number;attempt:"initial"|"recovery";finalizationHash:string}) {
  const e=structuredClone(expectation);
  if(!path.isAbsolute(projectRoot)||typeof taskId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(taskId)||
      !Number.isSafeInteger(e.revision)||e.revision<1||!["initial","recovery"].includes(e.attempt)||
      typeof e.finalizationHash!=="string"||!/^[a-f0-9]{64}(?![\s\S])/.test(e.finalizationHash))return fail();
  const reader=new OrcaReadOnlyStore(projectRoot),store={getTask:async(id:string)=>snapshot(projectRoot,id),
    readOrcaEvidence:reader.readOrcaEvidence.bind(reader)};
  const task=snapshot(projectRoot,taskId),commit=validatedOrcaCommit(task),b=task.orcaBinding!;
  const recovery=e.attempt==="recovery",r=task.orcaPrintRecoveryPreparation;
  const p=recovery?r?.preparation:task.orcaPrintReviewPreparation,
    i=recovery?task.orcaPrintRecoveryCaptureIntent:task.orcaPrintCaptureIntent,
    c=recovery?task.orcaPrintRecoveryCaptureResult:task.orcaPrintCaptureResult,
    f=recovery?task.orcaPrintRecoveryFinalization:task.orcaPrintReviewFinalization;
  if(!p||!i||!c||!f||(!recovery&&r)||task.status!=="REVIEW"||task.result!==undefined||task.pendingAgentTurn||
      task.pendingHumanResponse!==undefined||task.orcaReviewRun||task.orcaCompletion||task.orcaTaskCompletion||
      task.revision!==e.revision||f.finalizedRevision!==e.revision||f.finalizedRevision!==i.startedRevision+2||
      i.startedRevision!==p.preparedRevision+1||hash(f)!==e.finalizationHash||f.verdict!=="PASS"||
      f.version!==1||f.adapter!=="antigravity-print"||f.sourceAuthenticated!==false||f.canCompleteTask!==false||
      f.requestId!==p.requestId||i.requestId!==p.requestId||c.requestId!==p.requestId||c.status!=="CAPTURED"||
      f.captureHash!==hashOrcaPrintCapture(c)||f.reviewId!==p.subjects.reviewId||i.requestSha256!==p.request.sha256||
      p.bindingHash!==hash(b)||p.subjects.taskId!==taskId||p.subjects.digest!==commit.digest||p.subjects.generation!==commit.generation||
      commit.outbox.state!=="PROJECTED"||(commit.outbox.event.details as any).to!=="REVIEW"||
      b.developer!=="codex"||b.reviewer!=="gemini"||task.ownerType!=="AGENT"||task.owner!==b.developer||task.ownerId!==b.ownerId||
      (task.reviewerId??task.reviewer)!==b.reviewer||(task.claim?.id??null)!==b.claimId||
      (task.claim&&task.claim.ownerId!==b.ownerId)||!validGeminiPrintModel(i.model)||i.profile?.kind!=="view-file-v1")return fail();
  if(recovery&&(!r||task.orcaPrintReviewFinalization||task.orcaPrintCaptureResult?.status!=="FAILED"||
      r.previousRequestId!==task.orcaPrintReviewPreparation?.requestId||r.failedCaptureHash!==hashOrcaPrintCapture(task.orcaPrintCaptureResult)))return fail();
  const tests=validatedPassedOrcaTests(task),testHash=hashOrcaTestRun(tests);
  if(!tests.outputEvidence||testHash!==p.subjects.testRunHash||tests.id!==p.subjects.testRunId||
      tests.workspaceHash!==p.subjects.workspaceHash||f.workspaceHash!==tests.workspaceHash||
      !isDeepStrictEqual(tests.outputEvidence,p.testOutput)||!isDeepStrictEqual(task.orcaBaseline?.evidence,p.baseline))return fail();
  for(const ref of [p.requirements,p.testOutput,p.baseline]){
    if(!validOrcaEvidenceRef(ref)||ref.bytes>65536)return fail();await reader.readOrcaEvidence(ref);
  }
  const bytes={} as Record<keyof typeof c.files,Buffer>,budgets={request:65536,intent:32768,stdout:4194304,stderr:65536,process:32768};
  const oldBytes={} as typeof bytes;
  for(const key of ["request","intent","stdout","stderr","process"] as const){
    const ref=c.files[key];if(!validOrcaEvidenceRef(ref)||ref.bytes>budgets[key])return fail();bytes[key]=await reader.readOrcaEvidence(ref);
    if(recovery){const old=task.orcaPrintCaptureResult!.files[key];if(!validOrcaEvidenceRef(old)||old.bytes>budgets[key])return fail();oldBytes[key]=await reader.readOrcaEvidence(old);}
  }
  await reconcileRequest(reader,task,p,bytes.request);
  if(recovery){
    const op=task.orcaPrintReviewPreparation,oi=task.orcaPrintCaptureIntent,oc=task.orcaPrintCaptureResult!;
    if(!op||!oi||oi.requestId!==op.requestId||oc.requestId!==op.requestId||oi.requestSha256!==op.request.sha256||
        !validGeminiPrintModel(oi.model)||oi.startedRevision!==op.preparedRevision+1||p.preparedRevision!==oi.startedRevision+2||
        op.bindingHash!==hash(b)||!isDeepStrictEqual(oc.files.request,op.request)||
        !isDeepStrictEqual(op.subjects,{...p.subjects,reviewId:op.subjects.reviewId})||
        !isDeepStrictEqual(op.testOutput,p.testOutput)||!isDeepStrictEqual(op.baseline,p.baseline))return fail();
    await reconcileRequest(reader,task,op,oldBytes.request);
    const intent=parse(oldBytes.intent),receipt=parse(oldBytes.process),extra=oi.profile?{profile:oi.profile}:{};
    if(!isDeepStrictEqual(intent,{version:3,...extra,model:oi.model,requestId:op.requestId,executable:oi.executable,cwd:b.workspacePath,
        requestSha256:op.request.sha256,requestBytes:oldBytes.request.length,createdAt:intent?.createdAt,automaticRetry:false})||
        !isDeepStrictEqual(receipt,{version:3,...extra,model:oi.model,requestId:op.requestId,pid:receipt?.pid,code:0,signal:null,closedAt:receipt?.closedAt,
          failure:"PROTOCOL_FAILED",stdoutBytes:oldBytes.stdout.length,stderrBytes:oldBytes.stderr.length,
          stdoutSha256:createHash("sha256").update(oldBytes.stdout).digest("hex"),stderrSha256:createHash("sha256").update(oldBytes.stderr).digest("hex"),
          truncated:false,automaticRetry:false,sourceAuthenticated:false,terminalIdentityVerified:false,canFinalizeReview:false,canCompleteTask:false})||
        !Number.isSafeInteger(receipt?.pid)||receipt.pid<1||typeof intent?.createdAt!=="string"||!Number.isFinite(Date.parse(intent.createdAt))||
        typeof receipt?.closedAt!=="string"||!Number.isFinite(Date.parse(receipt.closedAt))||Date.parse(receipt.closedAt)<Date.parse(intent.createdAt))return fail();
  }
  if(!isDeepStrictEqual(c.files.request,p.request))return fail();
  const source=inspectAntigravityPrintSource(bytes.request,bytes.intent,bytes.stdout,bytes.stderr,bytes.process,
    JSON.stringify({requestId:p.requestId,cwd:b.workspacePath,executable:i.executable,requestSha256:p.request.sha256,profile:i.profile,model:i.model}));
  const parsed=decodeOrcaPrintResponse(source.response,f.responseFormat??"raw-json-v1"),answer=parsed.ok?parsed.value as any:null;
  if(!answer||Object.keys(answer).sort().join(",")!==[...Object.keys(p.subjects),"verdict"].sort().join(",")||
      answer.verdict!=="PASS"||Object.entries(p.subjects).some(([key,value])=>answer[key]!==value)||
      !validOrcaEvidenceRef(f.response)||f.response.bytes>262144||!(await reader.readOrcaEvidence(f.response)).equals(Buffer.from(source.response)))return fail();
  const eventBytes=readSnapshotBytes(projectRoot,["logs","tasks",`${taskId}.jsonl`],TASK_EVENT_LOG_MAX_BYTES);
  verifyTaskEventBytes(eventBytes,commit.outbox.event);
  const attribution=await inspectOrcaFileAttribution(store,taskId);
  if(!attribution.withinWhitelist||attribution.workspaceHash!==tests.workspaceHash||
      !isDeepStrictEqual(i.profile.allowedPaths,attribution.changedFiles.map(file=>path.join(b.workspacePath,file)).sort()))return fail();
  if(await fingerprintOrcaWorkspace(b.workspacePath)!==tests.workspaceHash)return fail();
  if(!readSnapshotBytes(projectRoot,["logs","tasks",`${taskId}.jsonl`],TASK_EVENT_LOG_MAX_BYTES).equals(eventBytes))return fail();
  if(!isDeepStrictEqual(snapshot(projectRoot,taskId),task))return fail();
  return {taskId,revision:e.revision,attempt:e.attempt,reviewEvidenceReady:true,sourceAuthenticated:false,canCompleteTask:false,
    approvalIssued:false,scope:"LOCAL_PRINT_COMPLETION_READINESS",subjects:{taskId,revision:e.revision,bindingHash:hash(b),
      deliveryDigest:commit.digest,testRunHash:testHash,finalizationHash:e.finalizationHash,captureHash:f.captureHash,
      workspaceHash:tests.workspaceHash,changedFiles:attribution.changedFiles},
    blockers:["ENROLLMENT_AND_LIFECYCLE_NOT_CHECKED","EXACT_COMPLETION_APPROVAL_ABSENT","PRINT_COMPLETION_TRANSACTION_NOT_IMPLEMENTED"]};
}
