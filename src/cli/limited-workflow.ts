import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {OrcaReadOnlyStore} from "../integrations/orca-read-only-store.js";
import {inspectOrcaLimitedReadiness} from "../integrations/orca-limited-readiness.js";
import {parseOrcaCompletionBinding} from "../integrations/orca-evidence-manifest.js";
import {fingerprintOrcaTaskCompletionImplementation,completeOrcaTaskLimited} from "../integrations/orca-task-completion.js";

const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}(?![\s\S])/.test(v);
const invalid=():never=>{throw Error("LIMITED_WORKFLOW_REJECTED");};

/** Bounded operator-selected input; retain a synchronous drift check across later awaits. */
function pinnedFile(filename:string,pin:string){
 if(typeof filename!=="string"||!path.isAbsolute(filename)||fs.realpathSync(filename)!==filename||!digest(pin))return invalid();
 const entry=fs.lstatSync(filename);
 if(!entry.isFile()||entry.nlink!==1||entry.size<1||entry.size>32768)return invalid();
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let raw:string;
 const revalidate=()=>{const now=fs.lstatSync(filename);if(fs.realpathSync(filename)!==filename||!now.isFile()||now.nlink!==1||
  now.dev!==entry.dev||now.ino!==entry.ino||now.size!==entry.size||now.mtimeMs!==entry.mtimeMs||now.ctimeMs!==entry.ctimeMs||now.mode!==entry.mode||now.uid!==entry.uid)return invalid();};
 try{
  const opened=fs.fstatSync(fd);if(opened.dev!==entry.dev||opened.ino!==entry.ino)return invalid();
  const bytes=Buffer.alloc(entry.size+1);let length=0;
  while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}
  const after=fs.fstatSync(fd);if(length!==entry.size||after.size!==entry.size||after.mtimeMs!==entry.mtimeMs||after.ctimeMs!==entry.ctimeMs)return invalid();
  raw=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,length));
 }finally{fs.closeSync(fd);}
 revalidate();if(sha(raw)!==pin)return invalid();return {raw,revalidate};
}

export interface LimitedWorkflowOptions {
 storeRoot:string;sessionsRoot:string;taskId:string;bundle:string;bundleSha256:string;policy:string;policySha256:string;
 output?:string;approvalSha256?:string;implementationSha256?:string;
}
export async function runLimitedWorkflow(action:"preflight"|"request"|"complete"|"reconcile",options:LimitedWorkflowOptions){
 const o=structuredClone(options);
 const common=["storeRoot","sessionsRoot","taskId","bundle","bundleSha256","policy","policySha256"];
 const keys=[...common,...(action==="request"?["output"]:[]),...(["complete","reconcile"].includes(action)?["approvalSha256","implementationSha256"]:[])];
 if(!["preflight","request","complete","reconcile"].includes(action)||!isDeepStrictEqual(Object.keys(o).sort(),keys.sort())||
  !path.isAbsolute(o.storeRoot)||!path.isAbsolute(o.sessionsRoot)||typeof o.taskId!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(o.taskId))return invalid();
 const bundle=pinnedFile(o.bundle,o.bundleSha256),policy=pinnedFile(o.policy,o.policySha256);
 if(action==="complete"||action==="reconcile"){
  if(!digest(o.approvalSha256)||!digest(o.implementationSha256))return invalid();
  bundle.revalidate();policy.revalidate();
  return completeOrcaTaskLimited({projectRoot:o.storeRoot,sessionsRoot:o.sessionsRoot,taskId:o.taskId,
   rawBundle:bundle.raw,rawPolicy:policy.raw,expectedApprovalDigest:o.approvalSha256,expectedImplementationDigest:o.implementationSha256,action});
 }
 const store=new OrcaReadOnlyStore(o.storeRoot),task=await store.getTask(o.taskId);
 if(!task)return invalid();
 if(action==="request"&&(task.status!=="REVIEW"||task.orcaTaskCompletion||task.orcaCompletion))return invalid();
 const original=task.orcaTaskCompletion?.originalTask;
 const readiness=await inspectOrcaLimitedReadiness(o.storeRoot,o.sessionsRoot,o.taskId,bundle.raw,o.bundleSha256,policy.raw,o.policySha256,original);
 if(!isDeepStrictEqual(await store.getTask(o.taskId),task))return invalid();
 bundle.revalidate();policy.revalidate();
 if(action==="preflight")return {currentStatus:task.status,currentRevision:task.revision,historicalSnapshot:!!original,readiness,canCompleteTask:false};
 const subjects={taskId:o.taskId,projectId:task.projectId,expectedRevision:task.revision,
  bindingDigest:parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding)).digest,originalTaskDigest:sha(JSON.stringify(task)),
  bundleDigest:o.bundleSha256,policyDigest:o.policySha256,enrollmentDigest:readiness.enrollmentDigest,
  implementationDigest:fingerprintOrcaTaskCompletionImplementation(),allowedFiles:readiness.allowedFiles,changedFiles:readiness.changedFiles};
 const request={version:1,purpose:"TASK_SCOPED_LIMITED_COMPLETION_FINAL_APPROVAL_REQUEST",status:"NOT_APPROVED",subjects,
  retainedGaps:["METADATA_EXCEPTION","USER_OWNED_RETAINED_TERMINAL","SOURCE_NOT_AUTHENTICATED"],
  approvalIssued:false,canCompleteTask:false,sourceAuthenticated:false,globalGateApproved:false,
  prerequisites:["INDEPENDENT_IMPLEMENTATION_REVIEW","OPERATOR_CODE_TOOLCHAIN_FREEZE","EXACT_HUMAN_APPROVAL_AND_PRIVATE_ISSUANCE"]};
 if(typeof o.output!=="string"||!path.isAbsolute(o.output)||fs.realpathSync(path.dirname(o.output))!==path.dirname(o.output))return invalid();
 // Exclusive creation: never overwrite a previous request or create missing directories.
 const fd=fs.openSync(o.output,"wx",0o600);
 try{fs.writeFileSync(fd,JSON.stringify(request,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const dir=fs.openSync(path.dirname(o.output),"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
 return {requestPath:o.output,requestSha256:sha(JSON.stringify(request,null,2)),approvalIssued:false,canCompleteTask:false};
}

export async function runLimitedWorkflowCli(action:"preflight"|"request"|"complete"|"reconcile",options:LimitedWorkflowOptions){
 try{console.log(JSON.stringify({ok:true,report:await runLimitedWorkflow(action,options)}));}
 catch{console.log(JSON.stringify({ok:false,code:"LIMITED_WORKFLOW_REJECTED",automaticRetry:false}));process.exitCode=1;}
}
