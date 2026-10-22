import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {Task} from "../tasks/task.js";
import type {TaskEvent} from "../tasks/task-events.js";
import {TaskRevisionStore} from "./task-revision-store.js";
import {withTaskFileLock} from "./task-file-lock.js";
import {readOrcaTaskEnrollment} from "./orca-local-enrollment.js";
import {parseOrcaCompletionBinding} from "./orca-evidence-manifest.js";
import {inspectOrcaLimitedReadiness} from "./orca-limited-readiness.js";
import {decodeOrcaJson} from "./orca-json.js";
import {writeTaskEvent,verifyTaskEventReadOnly} from "./task-event-store.js";
import {fingerprintOrcaWorkspace} from "./orca-tests.js";
import {fileURLToPath} from "node:url";

const sha=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}(?![\s\S])/.test(v);
const fail=(code:string):never=>{throw Error(code);};
/** Fixed critical implementation pin; caller must also freeze the runtime/toolchain. */
export function fingerprintOrcaTaskCompletionImplementation(){
 const self=fileURLToPath(import.meta.url),directory=path.dirname(self),ext=path.extname(self);
 const names=["orca-task-completion","orca-limited-readiness","orca-limited-exceptions","orca-local-enrollment",
  "orca-acceptance","orca-review","orca-baseline","orca-delivery","orca-evidence-manifest","orca-evidence",
  "orca-json","orca-read-only-store","orca-tests","task-revision-store","task-file-lock","task-event-store"];
 return sha(JSON.stringify(names.map(name=>[name,sha(syncFs.readFileSync(path.join(directory,name+ext)))])));
}
export interface TaskCompletionOptions {
 projectRoot:string;sessionsRoot:string;taskId:string;rawBundle:string;rawPolicy:string;
 expectedApprovalDigest:string;expectedImplementationDigest:string;action:"complete"|"reconcile";
}
export interface OrcaTaskCompletionRecord {
 version:1;purpose:"TASK_SCOPED_HUMAN_LIMITED_COMPLETION";completedAt:string;approvalDigest:string;
 originalTask:Task;originalTaskDigest:string;approval:Record<string,any>;
 observedChangedFiles:string[];
 outbox:{state:"PENDING"|"PROJECTED";event:TaskEvent};
}

/** Only the operator can install/pin this private local approval. Not human authentication. */
function readApproval(root:string,sessions:string,task:Task,pin:string){
 const {digest:bindingDigest}=parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding));
 const enrollment=readOrcaTaskEnrollment(root,sessions,{taskId:task.id,projectId:task.projectId,generation:task.orcaGeneration!,bindingDigest});
 const directories=[root,path.join(root,"data"),path.join(root,"data/orca-trust-v1"),sessions].map(name=>{
  const stat=syncFs.lstatSync(name);if(!stat.isDirectory()||syncFs.realpathSync(name)!==name)return fail("INVALID_TASK_APPROVAL");return {name,stat};
 });
 const filename=path.join(root,"data/orca-trust-v1",`${task.id}.limited-v2-approval.json`);
 const before=syncFs.lstatSync(filename),uid=process.getuid?.();
 if(!before.isFile()||before.nlink!==1||before.size<1||before.size>32768||(before.mode&0o777)!==0o600||(uid!==undefined&&before.uid!==uid))return fail("INVALID_TASK_APPROVAL");
 const fd=syncFs.openSync(filename,syncFs.constants.O_RDONLY|syncFs.constants.O_NOFOLLOW|syncFs.constants.O_NONBLOCK);
 let bytes:Buffer;
 try{
  const opened=syncFs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev)return fail("INVALID_TASK_APPROVAL");
  const buffer=Buffer.alloc(before.size+1);let length=0;
  while(length<buffer.length){const n=syncFs.readSync(fd,buffer,length,buffer.length-length,null);if(!n)break;length+=n;}
  const after=syncFs.fstatSync(fd),current=syncFs.lstatSync(filename);
  for(const stat of [after,current])if(!stat.isFile()||stat.nlink!==1||stat.ino!==before.ino||stat.dev!==before.dev||stat.size!==before.size||
   stat.mtimeMs!==before.mtimeMs||stat.ctimeMs!==before.ctimeMs||stat.mode!==before.mode||stat.uid!==before.uid)return fail("INVALID_TASK_APPROVAL");
  if(length!==before.size)return fail("INVALID_TASK_APPROVAL");bytes=buffer.subarray(0,length);
 }finally{syncFs.closeSync(fd);}
 if(sha(bytes)!==pin)return fail("TASK_APPROVAL_PIN_MISMATCH");
 const decoded=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
 const a=decoded.ok?decoded.value as any:null;
 if(!a||Object.keys(a).sort().join(",")!=="approvedAt,operator,purpose,retainedGaps,sourceAuthenticated,subjects,version"||a.version!==1||
  a.purpose!=="TASK_SCOPED_HUMAN_LIMITED_COMPLETION_APPROVAL"||a.sourceAuthenticated!==false||!isDeepStrictEqual(a.operator,enrollment.operator)||
  typeof a.approvedAt!=="string"||!Number.isFinite(Date.parse(a.approvedAt))||new Date(a.approvedAt).toISOString()!==a.approvedAt||
  Date.parse(a.approvedAt)>Date.now()||!isDeepStrictEqual(a.retainedGaps,["METADATA_EXCEPTION","USER_OWNED_RETAINED_TERMINAL","SOURCE_NOT_AUTHENTICATED"]))return fail("INVALID_TASK_APPROVAL");
 for(const {name,stat}of directories){const now=syncFs.lstatSync(name);if(!now.isDirectory()||syncFs.realpathSync(name)!==name||now.ino!==stat.ino||now.dev!==stat.dev||now.mode!==stat.mode||now.uid!==stat.uid)return fail("INVALID_TASK_APPROVAL");}
 if(!isDeepStrictEqual(readOrcaTaskEnrollment(root,sessions,{taskId:task.id,projectId:task.projectId,generation:task.orcaGeneration!,bindingDigest}),enrollment))return fail("INVALID_TASK_APPROVAL");
 return {approval:a,enrollmentDigest:enrollment.digest,bindingDigest};
}
function nextTask(record:OrcaTaskCompletionRecord):Task{
 const original=record.originalTask;
 return {...original,status:"DONE",revision:original.revision!+(record.outbox.state==="PENDING"?1:2),completedAt:record.completedAt,updatedAt:record.completedAt,
  progress:100,nextAction:record.outbox.state==="PENDING"?"Limited completion committed; explicit event reconciliation required":"Task-scoped human limited completion only; no global Gate approval",
  result:{status:"PASS",summary:"Human-supervised limited acceptance; metadata exception, retained user terminal and unauthenticated-source gaps preserved.",
   changedFiles:[...record.observedChangedFiles],testStatus:"PASS",reviewStatus:"PASS",rounds:original.currentRound,testCommand:original.testCommand},orcaTaskCompletion:record};
}

/** Operator-only, participating-writer locks. No model, worker, parent-rollup or automatic retry. */
export async function completeOrcaTaskLimited(input:TaskCompletionOptions){
 const o=structuredClone(input);
 if(Object.keys(o).sort().join(",")!=="action,expectedApprovalDigest,expectedImplementationDigest,projectRoot,rawBundle,rawPolicy,sessionsRoot,taskId"||
  !path.isAbsolute(o.projectRoot)||!path.isAbsolute(o.sessionsRoot)||typeof o.taskId!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(o.taskId)||
  !hash(o.expectedApprovalDigest)||!hash(o.expectedImplementationDigest)||typeof o.rawBundle!=="string"||typeof o.rawPolicy!=="string"||
  Buffer.byteLength(o.rawBundle)>32768||Buffer.byteLength(o.rawPolicy)>32768||!["complete","reconcile"].includes(o.action))return fail("INVALID_TASK_COMPLETION_INPUT");
 for(const root of [o.projectRoot,o.sessionsRoot])if(await fs.realpath(root)!==root)return fail("INVALID_COMPLETION_ROOT");
 const busy=()=>Error("TASK_COMPLETION_BUSY");
 return withTaskFileLock(o.projectRoot,o.taskId,"task-executions",busy,()=>withTaskFileLock(o.projectRoot,o.taskId,"task-writes",busy,async()=>{
  const store=new TaskRevisionStore(o.projectRoot),live=await store.read(o.taskId) as Task|null;
  if(!live?.orcaBinding||live.orcaCompletion)return fail("TASK_COMPLETION_NOT_READY");
  const record=live.orcaTaskCompletion,original=record?.originalTask??live;
  if(original.status!=="REVIEW"||original.result!==undefined||original.pendingAgentTurn||original.pendingHumanResponse!==undefined||original.orcaTaskCompletion||
   !Number.isSafeInteger(original.revision)||original.revision!<1||original.revision!>Number.MAX_SAFE_INTEGER-2)return fail("TASK_COMPLETION_NOT_READY");
  const issued=readApproval(o.projectRoot,o.sessionsRoot,original,o.expectedApprovalDigest);
  if(fingerprintOrcaTaskCompletionImplementation()!==o.expectedImplementationDigest)return fail("TASK_COMPLETION_IMPLEMENTATION_CHANGED");
  // Once committed, reconcile the durable snapshot/event, not a historical worktree.
  const readiness=record?undefined:await inspectOrcaLimitedReadiness(o.projectRoot,o.sessionsRoot,o.taskId,o.rawBundle,sha(o.rawBundle),o.rawPolicy,sha(o.rawPolicy),original);
  const subjects={taskId:o.taskId,projectId:original.projectId,expectedRevision:original.revision,bindingDigest:issued.bindingDigest,
   originalTaskDigest:sha(JSON.stringify(original)),bundleDigest:sha(o.rawBundle),policyDigest:sha(o.rawPolicy),
   enrollmentDigest:issued.enrollmentDigest,implementationDigest:o.expectedImplementationDigest,allowedFiles:record?record.approval.subjects.allowedFiles:readiness!.allowedFiles,
   changedFiles:record?record.observedChangedFiles:readiness!.changedFiles};
  if(!isDeepStrictEqual(issued.approval.subjects,subjects))return fail("TASK_COMPLETION_SUBJECT_MISMATCH");
  if(!record&&(!readiness!.retainedEvidenceConsistent||readiness!.enrollmentDigest!==subjects.enrollmentDigest))return fail("TASK_COMPLETION_ADMISSION_FAILED");
  const event:TaskEvent={id:`orca-task-limited-${o.expectedApprovalDigest}`,taskId:o.taskId,type:"TASK_COMPLETED",actor:issued.approval.operator.subject,
   timestamp:record?.completedAt??new Date().toISOString(),details:{from:"REVIEW",to:"DONE",scope:"TASK_SCOPED_HUMAN_LIMITED_COMPLETION",approvalDigest:o.expectedApprovalDigest,
    bundleDigest:subjects.bundleDigest,policyDigest:subjects.policyDigest,sourceAuthenticated:false,globalGateApproved:false}};
  if(Date.parse(event.timestamp)<Date.parse(issued.approval.approvedAt))return fail("TASK_COMPLETION_CLOCK_INVALID");
  if(record){
   if(Object.keys(record).sort().join(",")!=="approval,approvalDigest,completedAt,observedChangedFiles,originalTask,originalTaskDigest,outbox,purpose,version"||
    Object.keys(record.outbox??{}).sort().join(",")!=="event,state"||
    typeof record.completedAt!=="string"||!Number.isFinite(Date.parse(record.completedAt))||new Date(record.completedAt).toISOString()!==record.completedAt||
    record.version!==1||record.purpose!=="TASK_SCOPED_HUMAN_LIMITED_COMPLETION"||record.approvalDigest!==o.expectedApprovalDigest||
    record.originalTaskDigest!==subjects.originalTaskDigest||!isDeepStrictEqual(record.approval,issued.approval)||
    !["PENDING","PROJECTED"].includes(record.outbox?.state)||!isDeepStrictEqual(record.outbox.event,event)||!isDeepStrictEqual(live,nextTask(record)))return fail("TASK_COMPLETION_REPLAY_CONFLICT");
   const dir=await fs.open(path.join(o.projectRoot,"data/tasks"),"r");try{await dir.sync();}finally{await dir.close();}
   if(record.outbox.state==="PROJECTED"){await verifyTaskEventReadOnly(o.projectRoot,event);return {status:"DONE",revision:live.revision,outboxState:"PROJECTED",replay:true};}
   if(o.action==="complete")return {status:"DONE",revision:live.revision,outboxState:"PENDING",replay:true};
  }else if(o.action==="reconcile")return fail("NO_TASK_COMPLETION_TO_RECONCILE");
  const next:OrcaTaskCompletionRecord=record?{...record,outbox:{state:"PROJECTED",event}}:{version:1,purpose:"TASK_SCOPED_HUMAN_LIMITED_COMPLETION",completedAt:event.timestamp,
   approvalDigest:o.expectedApprovalDigest,originalTask:original,originalTaskDigest:subjects.originalTaskDigest,approval:issued.approval,
   observedChangedFiles:[...subjects.changedFiles],outbox:{state:"PENDING",event}};
  if(record){await writeTaskEvent(o.projectRoot,event,true);await verifyTaskEventReadOnly(o.projectRoot,event);}
  const directory=path.join(o.projectRoot,"data/tasks"),temp=path.join(directory,`.${o.taskId}.${randomUUID()}.limited.tmp`);
  try{
   const file=await fs.open(temp,"wx",0o600);try{await file.writeFile(JSON.stringify(nextTask(next),null,2));await file.sync();}finally{await file.close();}
   if((!record&&await fingerprintOrcaWorkspace(original.orcaBinding!.workspacePath)!==readiness!.acceptance.workspaceHash)||
     !isDeepStrictEqual(await store.read(o.taskId),live)||!isDeepStrictEqual(readApproval(o.projectRoot,o.sessionsRoot,original,o.expectedApprovalDigest),issued)||
     fingerprintOrcaTaskCompletionImplementation()!==o.expectedImplementationDigest)return fail("TASK_COMPLETION_FINAL_DRIFT");
   await fs.rename(temp,path.join(directory,`${o.taskId}.json`));
   const dir=await fs.open(directory,"r");try{await dir.sync();}finally{await dir.close();}
  }finally{await fs.unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;});}
  return {status:"DONE",revision:nextTask(next).revision,outboxState:next.outbox.state,replay:!!record,sourceAuthenticated:false,globalGateApproved:false};
 }));
}
