import fs from "node:fs";
import path from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { isDeepStrictEqual,TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import type { Task } from "../tasks/task.js";
import type { TaskEvent } from "../tasks/task-events.js";
import { decodeOrcaJson } from "./orca-json.js";
import { withTaskFileLock } from "./task-file-lock.js";
import { readOrcaPrintTaskSnapshot,readOrcaPrintTaskEventSnapshot } from "./orca-print-completion-readiness.js";
import { inspectOrcaPrintLimitedReadiness } from "./orca-print-limited-readiness.js";
import { readOrcaTaskEnrollment } from "./orca-local-enrollment.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { writeTaskEvent,verifyTaskEventBytes } from "./task-event-store.js";
import { inspectOrcaPrintCompletionRuntime } from "./orca-print-completion-runtime.js";

const sha=(v:Buffer|string)=>createHash("sha256").update(v).digest("hex");
const hash=(v:unknown)=>sha(JSON.stringify(v));
const digest=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}(?![\s\S])/.test(v);
const fail=(code:string):never=>{throw Error(code);};
const gaps=["USER_OWNED_RETAINED_TERMINAL","SOURCE_NOT_AUTHENTICATED","HISTORICAL_LIFECYCLE_ONLY"];
export interface OrcaPrintTaskCompletionRecord {
  version:1;purpose:"TASK_SCOPED_PRINT_LIMITED_COMPLETION";approvalDigest:string;approval:Record<string,any>;
  originalTask:Task;originalTaskDigest:string;completedAt:string;changedFiles:string[];
  outbox:{state:"PENDING"|"PROJECTED";event:TaskEvent};
}
export function fingerprintOrcaPrintCompletionImplementation(){
  const self=fileURLToPath(import.meta.url),dir=path.dirname(self),ext=path.extname(self);
  const names=["orca-print-task-completion","orca-print-completion-runtime","orca-print-limited-readiness","orca-print-completion-readiness","orca-retained-terminal",
    "orca-local-enrollment","orca-print-review-finalization","orca-print-response","antigravity-print-source","antigravity-print-capture",
    "antigravity-read-stream","antigravity-print-stream","orca-import","orca-delivery","orca-review","orca-review-response",
    "orca-baseline","orca-tests","orca-evidence","orca-read-only-store","orca-evidence-manifest","orca-json","task-file-lock","task-event-store","task-revision-store",
    "../git/git-service","../tasks/task-events","../agents/codex-review-transport"];
  return hash(names.map(name=>[name,sha(fs.readFileSync(path.join(dir,name+ext)))]));
}
function readApproval(root:string,sessions:string,task:Task,pin:string){
  const {binding,digest:bindingDigest}=parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding));
  const scope={taskId:task.id,projectId:task.projectId,generation:binding.generation,bindingDigest};
  const enrollment=readOrcaTaskEnrollment(root,sessions,scope),dir=path.join(root,"data/orca-trust-v1");
  const ds=fs.lstatSync(dir,{bigint:true});
  const file=path.join(dir,`${task.id}.print-limited-v1-approval.json`),before=fs.lstatSync(file,{bigint:true});
  if(fs.realpathSync(dir)!==dir||!ds.isDirectory()||(ds.mode&0o777n)!==0o700n||ds.uid!==BigInt(process.getuid!())||
      !before.isFile()||before.nlink!==1n||before.size<1n||before.size>32768n||(before.mode&0o777n)!==0o600n||before.uid!==BigInt(process.getuid!()))return fail("INVALID_PRINT_COMPLETION_APPROVAL");
  const same=(s:typeof before)=>s.isFile()&&s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mode===before.mode&&s.uid===before.uid&&
    s.nlink===before.nlink&&s.mtimeNs===before.mtimeNs&&s.ctimeNs===before.ctimeNs;
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let bytes:Buffer;
  try{
    if(!same(fs.fstatSync(fd,{bigint:true})))return fail("INVALID_PRINT_COMPLETION_APPROVAL");
    const buffer=Buffer.alloc(Number(before.size)+1);let count=0;
    while(count<buffer.length){const n=fs.readSync(fd,buffer,count,buffer.length-count,count);if(!n)break;count+=n;}
    if(count!==Number(before.size)||!same(fs.fstatSync(fd,{bigint:true}))||!same(fs.lstatSync(file,{bigint:true})))return fail("INVALID_PRINT_COMPLETION_APPROVAL");
    bytes=buffer.subarray(0,count);
  }finally{fs.closeSync(fd);}
  if(sha(bytes)!==pin)return fail("PRINT_COMPLETION_APPROVAL_PIN_MISMATCH");
  const p=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),a=p.ok?p.value as any:null;
  if(!a||Object.keys(a).sort().join(",")!=="approvedAt,operator,purpose,retainedGaps,sourceAuthenticated,subjects,version"||a.version!==1||
      a.purpose!=="TASK_SCOPED_PRINT_LIMITED_COMPLETION_APPROVAL"||a.sourceAuthenticated!==false||!isDeepStrictEqual(a.operator,enrollment.operator)||
      !isDeepStrictEqual(a.retainedGaps,gaps)||typeof a.approvedAt!=="string"||!Number.isFinite(Date.parse(a.approvedAt))||
      new Date(a.approvedAt).toISOString()!==a.approvedAt||Date.parse(a.approvedAt)>Date.now()||!a.subjects||typeof a.subjects!=="object"||Array.isArray(a.subjects))return fail("INVALID_PRINT_COMPLETION_APPROVAL");
  const now=fs.lstatSync(dir,{bigint:true});
  if(now.ino!==ds.ino||now.dev!==ds.dev||now.mode!==ds.mode||now.uid!==ds.uid||fs.realpathSync(dir)!==dir||
      !isDeepStrictEqual(readOrcaTaskEnrollment(root,sessions,scope),enrollment))return fail("PRINT_COMPLETION_APPROVAL_CHANGED");
  return {approval:a,enrollmentDigest:enrollment.digest,bindingDigest};
}
function completedTask(record:OrcaPrintTaskCompletionRecord):Task {
  const t=record.originalTask;
  return {...t,status:"DONE",revision:t.revision!+(record.outbox.state==="PENDING"?1:2),updatedAt:record.completedAt,completedAt:record.completedAt,progress:100,
    nextAction:record.outbox.state==="PENDING"?"Print limited completion committed; explicit event reconciliation required":"Task-scoped print limited completion only; no global Gate approval",
    result:{status:"PASS",summary:"Supervised limited acceptance; user-owned terminal, unauthenticated-source and historical-lifecycle gaps retained.",
      changedFiles:[...record.changedFiles],testStatus:"PASS",reviewStatus:"PASS",testCommand:t.testCommand,rounds:t.currentRound},orcaPrintTaskCompletion:record};
}
/** Operator-only explicit commit/reconciliation. Requires an already installed exact approval. */
export async function completeOrcaPrintTaskLimited(input:{projectRoot:string;sessionsRoot:string;taskId:string;
  expectedApprovalDigest:string;expectedImplementationDigest:string;action:"complete"|"reconcile";settlement:Buffer;release:Buffer}){
  if(!input||!Buffer.isBuffer(input.settlement)||!Buffer.isBuffer(input.release)||input.settlement.length>262144||input.release.length>262144)return fail("INVALID_PRINT_COMPLETION_INPUT");
  const o={...input,settlement:Buffer.from(input.settlement),release:Buffer.from(input.release)};
  const runtime=inspectOrcaPrintCompletionRuntime();
  if(!path.isAbsolute(o.projectRoot)||!path.isAbsolute(o.sessionsRoot)||typeof o.taskId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(o.taskId)||
      !digest(o.expectedApprovalDigest)||!digest(o.expectedImplementationDigest)||!["complete","reconcile"].includes(o.action))return fail("INVALID_PRINT_COMPLETION_INPUT");
  for(const root of [o.projectRoot,o.sessionsRoot])if(fs.realpathSync(root)!==root)return fail("UNSAFE_PRINT_COMPLETION_ROOT");
  const busy=()=>Error("PRINT_COMPLETION_BUSY");
  return withTaskFileLock(o.projectRoot,o.taskId,"task-executions",busy,()=>withTaskFileLock(o.projectRoot,o.taskId,"task-writes",busy,async()=>{
    const live=readOrcaPrintTaskSnapshot(o.projectRoot,o.taskId),record=live.orcaPrintTaskCompletion,original=record?.originalTask??live;
    if(live.orcaCompletion||live.orcaTaskCompletion||original.id!==o.taskId||original.status!=="REVIEW"||original.result!==undefined||original.pendingAgentTurn||original.pendingHumanResponse!==undefined||
        original.orcaPrintTaskCompletion||!Number.isSafeInteger(original.revision)||original.revision!<1||original.revision!>Number.MAX_SAFE_INTEGER-2)return fail("PRINT_COMPLETION_NOT_READY");
    const issued=readApproval(o.projectRoot,o.sessionsRoot,original,o.expectedApprovalDigest),a=issued.approval,subjects=a.subjects;
    if(subjects.runtimeArtifactDigest!==runtime.digest||fingerprintOrcaPrintCompletionImplementation()!==o.expectedImplementationDigest||subjects.implementationDigest!==o.expectedImplementationDigest||
        subjects.originalTaskDigest!==hash(original)||subjects.enrollmentDigest!==issued.enrollmentDigest||subjects.bindingDigest!==issued.bindingDigest||
        subjects.taskId!==o.taskId||subjects.revision!==original.revision||!isDeepStrictEqual(subjects.operator,issued.approval.operator)||
        sha(o.settlement)!==subjects.settlementSha256||sha(o.release)!==subjects.releaseSha256)return fail("PRINT_COMPLETION_SUBJECT_MISMATCH");
    let changedFiles:string[];
    if(record){
      if(Object.keys(record).sort().join(",")!=="approval,approvalDigest,changedFiles,completedAt,originalTask,originalTaskDigest,outbox,purpose,version"||
          Object.keys(record.outbox??{}).sort().join(",")!=="event,state"||record.version!==1||record.purpose!=="TASK_SCOPED_PRINT_LIMITED_COMPLETION"||record.approvalDigest!==o.expectedApprovalDigest||
          record.originalTaskDigest!==hash(original)||!isDeepStrictEqual(record.approval,a)||!["PENDING","PROJECTED"].includes(record.outbox?.state)||
          !isDeepStrictEqual(live,completedTask(record)))return fail("PRINT_COMPLETION_REPLAY_CONFLICT");
      changedFiles=record.changedFiles;
    }else{
      if(o.action!=="complete")return fail("NO_PRINT_COMPLETION_TO_RECONCILE");
      const ready=await inspectOrcaPrintLimitedReadiness(o.projectRoot,o.sessionsRoot,o.taskId,{revision:subjects.revision,attempt:subjects.attempt,
        finalizationHash:subjects.finalizationHash,enrollmentDigest:subjects.enrollmentDigest,settlementSha256:subjects.settlementSha256,
        releaseSha256:subjects.releaseSha256,workerIncarnation:subjects.workerIncarnation},o.settlement,o.release);
      if(!isDeepStrictEqual({...ready.subjects,attempt:subjects.attempt,implementationDigest:o.expectedImplementationDigest,runtimeArtifactDigest:runtime.digest},subjects))return fail("PRINT_COMPLETION_SUBJECT_MISMATCH");
      changedFiles=ready.subjects.changedFiles;
    }
    const completedAt=record?.completedAt??new Date().toISOString();
    if(!Number.isFinite(Date.parse(completedAt))||new Date(completedAt).toISOString()!==completedAt||Date.parse(completedAt)<Date.parse(a.approvedAt))return fail("PRINT_COMPLETION_CLOCK_INVALID");
    const event:TaskEvent={id:`orca-print-limited-${o.expectedApprovalDigest}`,taskId:o.taskId,type:"TASK_COMPLETED",actor:a.operator.subject,timestamp:completedAt,
      details:{from:"REVIEW",to:"DONE",scope:"TASK_SCOPED_PRINT_LIMITED_COMPLETION",approvalDigest:o.expectedApprovalDigest,
        finalizationHash:subjects.finalizationHash,sourceAuthenticated:false,globalGateApproved:false}};
    if(record){
      if(!isDeepStrictEqual(record.outbox.event,event)||!isDeepStrictEqual(record.changedFiles,subjects.changedFiles))return fail("PRINT_COMPLETION_REPLAY_CONFLICT");
      const directory=fs.openSync(path.join(o.projectRoot,"data/tasks"),"r");try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
      if(record.outbox.state==="PROJECTED"){verifyTaskEventBytes(readOrcaPrintTaskEventSnapshot(o.projectRoot,o.taskId),event);return {status:"DONE",revision:live.revision,outboxState:"PROJECTED",replay:true,globalGateApproved:false};}
      if(o.action==="complete")return {status:"DONE",revision:live.revision,outboxState:"PENDING",replay:true,globalGateApproved:false};
      await writeTaskEvent(o.projectRoot,event,true);verifyTaskEventBytes(readOrcaPrintTaskEventSnapshot(o.projectRoot,o.taskId),event);
    }
    const next:OrcaPrintTaskCompletionRecord={version:1,purpose:"TASK_SCOPED_PRINT_LIMITED_COMPLETION",approvalDigest:o.expectedApprovalDigest,
      approval:a,originalTask:original,originalTaskDigest:hash(original),completedAt,changedFiles:[...changedFiles],outbox:{state:record?"PROJECTED":"PENDING",event}};
    if(!record&&await fingerprintOrcaWorkspace(original.orcaBinding!.workspacePath)!==subjects.workspaceHash)return fail("PRINT_COMPLETION_WORKSPACE_CHANGED");
    const dir=path.join(o.projectRoot,"data/tasks"),temp=path.join(dir,`.${o.taskId}.${randomUUID()}.print-completion.tmp`);
    const serialized=JSON.stringify(completedTask(next),null,2),decoded=decodeOrcaJson(serialized);
    if(!decoded.ok)return fail("PRINT_COMPLETION_PAYLOAD_LIMIT");
    try{
      const fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(fd,serialized);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      if(!isDeepStrictEqual(readOrcaPrintTaskSnapshot(o.projectRoot,o.taskId),live)||!isDeepStrictEqual(readApproval(o.projectRoot,o.sessionsRoot,original,o.expectedApprovalDigest),issued)||
          fingerprintOrcaPrintCompletionImplementation()!==o.expectedImplementationDigest||
          inspectOrcaPrintCompletionRuntime().digest!==runtime.digest)return fail("PRINT_COMPLETION_FINAL_DRIFT");
      fs.renameSync(temp,path.join(dir,`${o.taskId}.json`));
      const directory=fs.openSync(dir,"r");try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    }finally{try{fs.unlinkSync(temp);}catch(e:any){if(e.code!=="ENOENT")throw e;}}
    return {status:"DONE",revision:completedTask(next).revision,outboxState:next.outbox.state,replay:!!record,sourceAuthenticated:false,globalGateApproved:false};
  }));
}
