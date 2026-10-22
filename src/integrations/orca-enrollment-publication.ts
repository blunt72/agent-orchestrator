import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inspectOrcaEnrollmentBytes,readOrcaTaskEnrollment } from "./orca-local-enrollment.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { TaskRevisionStore } from "./task-revision-store.js";
import { withTaskFileLock } from "./task-file-lock.js";
import type { Task } from "../tasks/task.js";

const fail=(code:string):never=>{throw Error(code);};
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");

/** Explicit local registration only. Operator identifiers are not authenticated. */
export interface OrcaEnrollmentPublicationInput {
  projectRoot:string;sessionsRoot:string;taskId:string;expectedRevision:number;
  record:Buffer;recordSha256:string;action:"install"|"reconcile";
}
export async function publishOrcaEnrollment(input:OrcaEnrollmentPublicationInput,
  phase:"review"|"development"="review"){
  if(phase!=="review"&&phase!=="development")return fail("INVALID_ENROLLMENT_PHASE");
  if(!Buffer.isBuffer(input.record)||input.record.length<1||input.record.length>16384)
    return fail("INVALID_TASK_ENROLLMENT_REGISTRATION");
  const o={...input,record:Buffer.isBuffer(input.record)?Buffer.from(input.record):input.record};
  if(typeof o.taskId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(o.taskId)||
      !Number.isSafeInteger(o.expectedRevision)||o.expectedRevision<1||!Buffer.isBuffer(o.record)||o.record.length>16384||
      typeof o.recordSha256!=="string"||!/^[a-f0-9]{64}(?![\s\S])/.test(o.recordSha256)||sha(o.record)!==o.recordSha256||
      !["install","reconcile"].includes(o.action))return fail("INVALID_TASK_ENROLLMENT_REGISTRATION");
  const trust=path.join(o.projectRoot,"data/orca-trust-v1"),evidence=path.join(o.projectRoot,"data/orca-evidence-v1");
  const directories=[o.projectRoot,o.sessionsRoot,path.join(o.projectRoot,"data"),trust,evidence].map(name=>{
    if(!path.isAbsolute(name)||fs.realpathSync(name)!==name)return fail("UNSAFE_ENROLLMENT_ROOT");
    const stat=fs.lstatSync(name,{bigint:true});if(!stat.isDirectory())return fail("UNSAFE_ENROLLMENT_ROOT");return {name,stat};
  });
  const t=fs.lstatSync(trust);if((t.mode&0o777)!==0o700||t.uid!==process.getuid!())return fail("UNSAFE_ENROLLMENT_ROOT");
  const unchanged=()=>{for(const {name,stat} of directories){const now=fs.lstatSync(name,{bigint:true});
    if(!now.isDirectory()||now.ino!==stat.ino||now.dev!==stat.dev||now.mode!==stat.mode||now.uid!==stat.uid||fs.realpathSync(name)!==name)return fail("ENROLLMENT_ROOT_CHANGED");}};
  const busy=()=>Error("ENROLLMENT_REGISTRATION_BUSY");
  return withTaskFileLock(o.projectRoot,o.taskId,"task-executions",busy,()=>withTaskFileLock(o.projectRoot,o.taskId,"task-writes",busy,async()=>{
    const store=new TaskRevisionStore(o.projectRoot),task=await store.read(o.taskId) as Task|null;
    if(!task?.orcaBinding||task.id!==o.taskId||task.status!==(phase==="review"?"REVIEW":"DOING")||task.result!==undefined||task.pendingAgentTurn||
        task.pendingHumanResponse!==undefined||task.revision!==o.expectedRevision||task.orcaTaskCompletion||task.orcaCompletion)return fail("TASK_ENROLLMENT_NOT_READY");
    if(phase==="development"&&(!task.orcaBaseline||task.orcaPrintTaskCompletion))return fail("TASK_ENROLLMENT_NOT_READY");
    const {binding,digest}=parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding));
    if(binding.agenthubTaskId!==o.taskId||binding.projectId!==task.projectId||binding.generation!==task.orcaGeneration)return fail("TASK_ENROLLMENT_NOT_READY");
    if(phase==="development"&&(task.ownerType!=="AGENT"||task.owner!==binding.developer||task.ownerId!==binding.ownerId||
      (task.reviewerId??task.reviewer)!==binding.reviewer||(task.claim?.id??null)!==binding.claimId||
      (task.claim&&task.claim.ownerId!==binding.ownerId)||(task.worktree??task.workspace)!==binding.workspacePath))
      return fail("TASK_ENROLLMENT_NOT_READY");
    const scope={taskId:o.taskId,projectId:task.projectId,generation:binding.generation,bindingDigest:digest};
    const validated=inspectOrcaEnrollmentBytes(o.record,o.sessionsRoot,evidence,scope);
    unchanged();
    const target=path.join(trust,`${o.taskId}.enrollment.json`);
    const temporary=path.join(trust,`.${o.taskId}.${o.recordSha256}.enrollment.tmp`);
    let present=false;try{fs.lstatSync(target);present=true;}catch(e:any){if(e.code!=="ENOENT")throw e;}
    if(present){
      if(o.action!=="reconcile")return fail("TASK_ENROLLMENT_ALREADY_EXISTS");
      const published=fs.lstatSync(target,{bigint:true});
      if(published.nlink===2n){
        const temp=fs.lstatSync(temporary,{bigint:true});
        const same=(s:typeof published)=>s.isFile()&&s.dev===published.dev&&s.ino===published.ino&&s.nlink===2n&&
          s.size===published.size&&s.mode===published.mode&&s.uid===published.uid&&s.mtimeNs===published.mtimeNs&&s.ctimeNs===published.ctimeNs;
        if(!same(temp)||!same(published)||published.size!==BigInt(o.record.length)||
            (published.mode&0o777n)!==0o600n||published.uid!==BigInt(process.getuid!()))return fail("UNSAFE_ENROLLMENT_INTERMEDIATE");
        const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        try{
          if(!same(fs.fstatSync(fd,{bigint:true})))return fail("UNSAFE_ENROLLMENT_INTERMEDIATE");
          const bytes=Buffer.alloc(o.record.length+1);let count=0;
          while(count<bytes.length){const n=fs.readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
          if(count!==o.record.length||!bytes.subarray(0,count).equals(o.record)||!same(fs.fstatSync(fd,{bigint:true}))||
              !same(fs.lstatSync(target,{bigint:true}))||!same(fs.lstatSync(temporary,{bigint:true})))return fail("UNSAFE_ENROLLMENT_INTERMEDIATE");
          unchanged();fs.unlinkSync(temporary);
        }finally{fs.closeSync(fd);}
      }
      const existing=readOrcaTaskEnrollment(o.projectRoot,o.sessionsRoot,scope);
      if(existing.digest!==o.recordSha256)return fail("TASK_ENROLLMENT_REPLAY_CONFLICT");
      if(!isDeepStrictEqual(await store.read(o.taskId),task))return fail("TASK_ENROLLMENT_SNAPSHOT_CHANGED");
      unchanged();const dir=fs.openSync(trust,"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
      return {...existing,installed:true,replay:true,taskMutated:false};
    }
    if(o.action==="reconcile")return fail("TASK_ENROLLMENT_NOT_INSTALLED");
    const fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(fd,o.record);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{
      if(!isDeepStrictEqual(await store.read(o.taskId),task))return fail("TASK_ENROLLMENT_SNAPSHOT_CHANGED");
      unchanged();fs.linkSync(temporary,target);
    }finally{fs.unlinkSync(temporary);}
    const dir=fs.openSync(trust,"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    const installed=readOrcaTaskEnrollment(o.projectRoot,o.sessionsRoot,scope);
    if(installed.digest!==validated.digest)return fail("TASK_ENROLLMENT_PUBLICATION_CHANGED");
    return {...installed,installed:true,replay:false,taskMutated:false};
  }));
}
