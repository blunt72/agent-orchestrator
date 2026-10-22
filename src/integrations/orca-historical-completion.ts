import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {withTaskFileLock} from './task-file-lock.js';
import {writeTaskEvent} from './task-event-store.js';
import {snapshotOrcaBinding} from './orca-delivery.js';
import type {Task} from '../tasks/task.js';
import type {TaskEvent} from '../tasks/task-events.js';

export const HISTORICAL_GAPS = ['REVISION_ORIGINAL_UNAVAILABLE', 'RETAINED_CLI_NOT_FORMAL_ADAPTER',
  'NO_FORMAL_DELIVERY_TEST_REVIEW_RECEIPTS', 'SOURCE_NOT_AUTHENTICATED'] as const;
const ROLES = ['registration', 'worker_done', 'review', 'test_output', 'test_exit', 'release', 'settlement',
  'baseline', 'source_file', 'test_file'] as const;
const MAX_RECORD_BYTES=4*1024*1024;
type Role = typeof ROLES[number];
interface Material {role:Role; path:string; sha256:string; bytes:number}
export interface HistoricalApproval {
  version:1; purpose:'HUMAN_HISTORICAL_CLOSURE_WITH_GAPS'; operationId:string; operator:string; approvedAt:string;
  sourceAuthenticated:false; acceptedGaps:typeof HISTORICAL_GAPS;
  subjects:{taskId:string; expectedRevision:number; taskSha256:string; bindingSha256:string; baselineSha256:string;
    implementationSha256:string; materials:Material[]};
}
export interface OrcaHistoricalCompletion {
  version:1; kind:'HISTORICAL_CLOSED_WITH_GAPS'; normalAcceptancePassed:false; sourceAuthenticated:false;
  approval:HistoricalApproval; approvalDigest:string; originalTaskUtf8:string; completedAt:string;
  committedRevision:number; outbox:{state:'PENDING'|'PROJECTED'; event:TaskEvent};
}
const hash = (s:string|Buffer) => createHash('sha256').update(s).digest('hex');
const validHash = (v:unknown):v is string => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const jsonHash = (v:unknown) => hash(JSON.stringify(v));
const fail = (code:string):never => {throw Error(code);};
const keys = (v:any, wanted:string[]) => v && !Array.isArray(v) && typeof v==='object' &&
  Object.keys(v).sort().join(',')===wanted.sort().join(',');
export const fingerprintHistoricalImplementation = () => {
  const self=new URL(import.meta.url), extension=path.extname(self.pathname);
  const imports=['orca-historical-completion','task-file-lock','task-event-store','task-revision-store','task-revision-snapshot','orca-evidence','orca-json','orca-delivery',
    '../tasks/task-events','../projects/dependency-resolver','../projects/project-engine','../server/dashboard'];
  return jsonHash(imports.map(name=>[name,hash(fs.readFileSync(new URL(name+extension,self)))]));
};

function safeRead(filename:string, privateFile=false):Buffer {
  if(!path.isAbsolute(filename)||path.resolve(filename)!==filename) fail('UNSAFE_HISTORICAL_PATH');
  let current=path.parse(filename).root;
  for(const part of filename.slice(current.length).split(path.sep)) {
    current=path.join(current,part); const s=fs.lstatSync(current);
    if(s.isSymbolicLink()) fail('SYMLINK_HISTORICAL_PATH');
  }
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const before=fs.fstatSync(fd);
    if(!before.isFile()||before.nlink!==1||before.size>MAX_RECORD_BYTES||
      (privateFile&&((before.mode&0o077)!==0||(process.getuid&&before.uid!==process.getuid())))) fail('UNSAFE_HISTORICAL_FILE');
    const data=fs.readFileSync(fd), after=fs.fstatSync(fd);
    if(before.ino!==after.ino||before.size!==data.length||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)
      fail('HISTORICAL_FILE_CHANGED');
    return data;
  } finally {fs.closeSync(fd);}
}

function approval(root:string, taskId:string, expected:string):HistoricalApproval {
  const bytes=safeRead(path.join(root,'data/orca-trust-v1',taskId+'.historical-v1-approval.json'),true);
  if(!validHash(expected)||hash(bytes)!==expected) fail('HISTORICAL_APPROVAL_PIN_MISMATCH');
  const a=JSON.parse(bytes.toString('utf8')) as HistoricalApproval, s=a?.subjects;
  if(!keys(a,['version','purpose','operationId','operator','approvedAt','sourceAuthenticated','acceptedGaps','subjects'])||
    a.version!==1||a.purpose!=='HUMAN_HISTORICAL_CLOSURE_WITH_GAPS'||a.sourceAuthenticated!==false||
    typeof a.operationId!=='string'||!/^[a-zA-Z0-9_.-]{1,128}$/.test(a.operationId)||
    typeof a.operator!=='string'||!a.operator.trim()||a.operator.length>256||
    typeof a.approvedAt!=='string'||!Number.isFinite(Date.parse(a.approvedAt))||Date.parse(a.approvedAt)>Date.now()||
    !isDeepStrictEqual(a.acceptedGaps,[...HISTORICAL_GAPS])) fail('INVALID_HISTORICAL_APPROVAL');
  validateSubjects(taskId,s);
  return a;
}

function validateSubjects(taskId:string,s:HistoricalApproval['subjects']) {
  if(!keys(s,['taskId','expectedRevision','taskSha256','bindingSha256','baselineSha256','implementationSha256','materials'])||
    s.taskId!==taskId||!Number.isSafeInteger(s.expectedRevision)||s.expectedRevision<1||s.expectedRevision>Number.MAX_SAFE_INTEGER-2||
    ![s.taskSha256,s.bindingSha256,s.baselineSha256,s.implementationSha256].every(validHash)||
    s.implementationSha256!==fingerprintHistoricalImplementation()||!Array.isArray(s.materials)||s.materials.length!==ROLES.length)
    fail('INVALID_HISTORICAL_APPROVAL');
  const roles=new Set<string>(), paths=new Set<string>();
  for(const m of s.materials) {
    if(!keys(m,['role','path','sha256','bytes'])||!ROLES.includes(m.role)||roles.has(m.role)||paths.has(m.path)||
      typeof m.path!=='string'||!validHash(m.sha256)||!Number.isSafeInteger(m.bytes)||m.bytes<0||m.bytes>4*1024*1024)
      fail('INVALID_HISTORICAL_MANIFEST');
    roles.add(m.role);paths.add(m.path);
  }
}

function verifyMaterials(a:Pick<HistoricalApproval,'subjects'>, original:Task) {
  const content=new Map<Role,Buffer>();
  for(const m of a.subjects.materials) {
    const b=safeRead(m.path); if(b.length!==m.bytes||hash(b)!==m.sha256) fail('HISTORICAL_MATERIAL_CHANGED');
    content.set(m.role,b);
  }
  const object=(r:Role)=>JSON.parse(content.get(r)!.toString('utf8'));
  const b=original.orcaBinding!;
  const review=object('review'), release=object('release'), settled=object('settlement');
  const done=object('worker_done'), registration=object('registration'), baseline=object('baseline');
  const messages=done.result?.messages;
  // Older public receipts identify the exact worker terminal; current scoped
  // receipts may identify dispatch:<id>. Neither form may be guessed/aliased.
  const message=Array.isArray(messages)?messages.find((m:any)=>m.type==='worker_done'&&
    (m.from_handle==='dispatch:'+b.dispatchId||m.from_handle===b.terminalHandle)&&
    m.to_handle==='run:'+b.runId&&m.run_id===b.runId):null;
  let payload:any;try{payload=JSON.parse(message?.payload);}catch{fail('INVALID_HISTORICAL_DELIVERY');}
  const worker=settled.result?.workers?.find((w:any)=>w.dispatchId===b.dispatchId);
  const source=a.subjects.materials.find(m=>m.role==='source_file')!, test=a.subjects.materials.find(m=>m.role==='test_file')!;
  const refs=registration.refs;
  const referenced=(r:Role)=>{
    const material=a.subjects.materials.find(m=>m.role===r)!;
    return Array.isArray(refs)&&refs.some((v:any)=>v.path===material.path&&v.evidence?.sha256===material.sha256&&v.evidence?.bytes===material.bytes);
  };
  if(done.ok!==true||done._meta?.runtimeId!==b.runtimeId||done.result?.runId!==b.runId||payload?.dispatchId!==b.dispatchId||
    payload?.taskId!==b.taskId||payload?.outcome!=='succeeded'||
    review.target?.dispatchId!==b.dispatchId||review.target?.taskId!==b.taskId||review.target?.runId!==b.runId||
    review.target?.workerHandle!==b.terminalHandle||review.finalVerdict!=='APPROVED'||
    review.whitelistCheck?.passed!==true||review.sourceCodeReview?.passed!==true||review.testExecutionReview?.passed!==true||
    object('test_exit').exitCode!==0||release.ok!==true||release._meta?.runtimeId!==b.runtimeId||
    release.result?.dispatchId!==b.dispatchId||release.result?.state!=='released'||
    settled.ok!==true||settled._meta?.runtimeId!==b.runtimeId||worker?.taskId!==b.taskId||worker?.runId!==b.runId||
    worker?.workerState!=='succeeded'||worker?.dispatchStatus!=='completed'||worker?.resource?.releaseState!=='released'||
    worker?.agentTerminalHandle!==b.terminalHandle||registration.taskId!==original.id||
    registration.sourceHashes?.['src/curriculum-catalog.mjs']!==source.sha256||
    registration.sourceHashes?.['test/curriculum-catalog.test.mjs']!==test.sha256||
    source.path!==path.join(b.workspacePath,'src/curriculum-catalog.mjs')||
    test.path!==path.join(b.workspacePath,'test/curriculum-catalog.test.mjs')||
    !['worker_done','review','test_output','test_exit','release'].every(r=>referenced(r as Role))||
    baseline.taskId!==original.id||baseline.generation!==b.generation||baseline.bindingRevision!==b.revision||
    hash(content.get('baseline')!)!==original.orcaBaseline?.evidence.sha256||
    content.get('baseline')!.length!==original.orcaBaseline?.evidence.bytes||
    !isDeepStrictEqual([...baseline.allowedFiles].sort(),['src/curriculum-catalog.mjs','test/curriculum-catalog.test.mjs']))
    fail('HISTORICAL_EVIDENCE_IDENTITY_MISMATCH');
}

function inspectOriginal(raw:Buffer,taskId:string,s:HistoricalApproval['subjects']):Task {
  const task=JSON.parse(raw.toString('utf8')) as Task;
  if(hash(raw)!==s.taskSha256||task.id!==taskId||task.revision!==s.expectedRevision||
    task.status!=='DOING'||task.pendingAgentTurn||task.result||!task.orcaBinding||!task.orcaBaseline||
    task.orcaHistoricalCompletion||task.orcaDelivery||task.orcaTestRun||task.orcaReviewRun||
    task.orcaCompletion||task.orcaTaskCompletion||task.orcaPrintTaskCompletion||
    jsonHash(task.orcaBinding)!==s.bindingSha256||jsonHash(task.orcaBaseline)!==s.baselineSha256||
    !snapshotOrcaBinding(task.orcaBinding)||task.orcaBinding.agenthubTaskId!==taskId||
    task.orcaBinding.projectId!==task.projectId||task.orcaBinding.workspacePath!==(task.worktree??task.workspace)||
    task.orcaBinding.generation!==task.orcaGeneration||task.ownerType!=='AGENT'||task.owner!==task.orcaBinding.developer||
    (task.reviewerId??task.reviewer)!==task.orcaBinding.reviewer||
    task.orcaBinding.claimId!==(task.claim?.id??null)||task.ownerId!==task.orcaBinding.ownerId)
    fail('HISTORICAL_ADMISSION_FAILED');
  return task;
}

/** Side-effect-free material preflight, not approval, locking or a completion.
 * Raw JSON subjects only. No fake approval file or task mutation is needed.
 */
export function inspectHistoricalReadiness(root:string,taskId:string,rawSubjects:string) {
  if(!path.isAbsolute(root)||fs.realpathSync(root)!==root||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(taskId)||
    typeof rawSubjects!=='string'||Buffer.byteLength(rawSubjects)>MAX_RECORD_BYTES)fail('INVALID_HISTORICAL_INSPECTION');
  const subjects=JSON.parse(rawSubjects) as HistoricalApproval['subjects'];validateSubjects(taskId,subjects);
  const target=path.join(root,'data/tasks',taskId+'.json'),raw=safeRead(target),task=inspectOriginal(raw,taskId,subjects);
  verifyMaterials({subjects},task);
  validateSubjects(taskId,subjects);verifyMaterials({subjects},task);
  if(!safeRead(target).equals(raw))fail('HISTORICAL_INSPECTION_CHANGED');
  return {taskId,revision:task.revision,materialsMatched:true,approvalIssued:false,canCompleteTask:false,
    sourceAuthenticated:false,atomicSnapshot:false,scope:'READ_ONLY_HISTORICAL_MATERIAL_PREFLIGHT' as const};
}

function derived(original:Task, record:OrcaHistoricalCompletion):Task {
  return {...original,status:'DONE',progress:100,completedAt:record.completedAt,updatedAt:record.completedAt,
    revision:record.committedRevision+(record.outbox.state==='PROJECTED'?1:0),
    nextAction:'历史结案（保留缺口）；非正常正式验收通过',orcaHistoricalCompletion:record};
}

function taskBytes(value:Task):Buffer {
  const bytes=Buffer.from(JSON.stringify(value,null,2),'utf8');
  if(bytes.length>MAX_RECORD_BYTES)fail('HISTORICAL_RECORD_TOO_LARGE');
  return bytes;
}

function confirmTaskDurability(root:string, taskId:string, expected:Buffer) {
  const directory=path.join(root,'data/tasks'),filename=path.join(directory,taskId+'.json');
  try {
    if(!safeRead(filename).equals(expected))fail('HISTORICAL_CAS_CONFLICT');
    const file=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{fs.fsyncSync(file);}finally{fs.closeSync(file);}
    const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    if(!safeRead(filename).equals(expected))fail('HISTORICAL_CAS_CONFLICT');
  }catch(error){throw new Error('HISTORICAL_DURABILITY_UNCONFIRMED',{cause:error});}
}

async function atomicTask(root:string, taskId:string, value:Task, expectedBytes:Buffer, recheck:()=>void) {
  const bytes=taskBytes(value);
  const directory=path.join(root,'data/tasks'), target=path.join(directory,taskId+'.json');
  let temporary:string|undefined=path.join(directory,'.'+taskId+'.'+randomUUID()+'.historical.tmp');
  try {
    const fd=await fsp.open(temporary,'wx',0o600);
    try {await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
    recheck();if(!safeRead(target).equals(expectedBytes)) fail('HISTORICAL_CAS_CONFLICT');
    // Participating writers hold task-writes; arbitrary external writers are not fenced.
    fs.renameSync(temporary,target);temporary=undefined;
    confirmTaskDurability(root,taskId,bytes);
  } finally {if(temporary)await fsp.unlink(temporary).catch(()=>{});}
}

/** Explicit operator API only; no CLI/HTTP route. Fixed private local decision is
 * not human authentication. Human review/application authority is external. */
export async function completeHistoricalTask(root:string, taskId:string, approvalDigest:string,
  action:'complete'|'reconcile'='complete') {
  if(!path.isAbsolute(root)||fs.realpathSync(root)!==root||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(taskId)||
    !['complete','reconcile'].includes(action)) fail('INVALID_HISTORICAL_OPERATION');
  const busy=()=>Error('HISTORICAL_TASK_BUSY');
  return withTaskFileLock(root,taskId,'task-executions',busy,()=>
    withTaskFileLock(root,taskId,'task-writes',busy,async()=>{
      const target=path.join(root,'data/tasks',taskId+'.json'), raw=safeRead(target), task=JSON.parse(raw.toString('utf8')) as Task;
      const a=approval(root,taskId,approvalDigest);let record=task.orcaHistoricalCompletion;
      if(record) {
        if(record.approvalDigest!==approvalDigest||!isDeepStrictEqual(record.approval,a)||
          record.kind!=='HISTORICAL_CLOSED_WITH_GAPS'||record.normalAcceptancePassed!==false||record.sourceAuthenticated!==false||
          !['PENDING','PROJECTED'].includes(record.outbox.state)) fail('HISTORICAL_REPLAY_CONFLICT');
        const original=JSON.parse(record.originalTaskUtf8) as Task;
        const expectedEvent:TaskEvent={id:'historical-'+hash(taskId+':'+approvalDigest),taskId,type:'TASK_HISTORICALLY_CLOSED',actor:a.operator,
          timestamp:record.completedAt,details:{from:original.status,to:'DONE',kind:'HISTORICAL_CLOSED_WITH_GAPS',
            approvalDigest,normalAcceptancePassed:false,sourceAuthenticated:false,retainedGaps:[...HISTORICAL_GAPS]}};
        if(!keys(record,['version','kind','normalAcceptancePassed','sourceAuthenticated','approval','approvalDigest',
            'originalTaskUtf8','completedAt','committedRevision','outbox'])||record.version!==1||
          !keys(record.outbox,['state','event'])||!isDeepStrictEqual(record.outbox.event,expectedEvent)||
          record.committedRevision!==a.subjects.expectedRevision+1||!Number.isFinite(Date.parse(record.completedAt))||
          Date.parse(record.completedAt)<Date.parse(a.approvedAt)||hash(record.originalTaskUtf8)!==a.subjects.taskSha256||
          !isDeepStrictEqual(task,derived(original,record))) fail('HISTORICAL_RECORD_CORRUPT');
        // A visible rename after a failed fsync is not yet a durable commit.
        // Confirm it before replay success OR before publishing its event.
        confirmTaskDurability(root,taskId,raw);
      } else {
        if(action!=='complete')fail('HISTORICAL_ADMISSION_FAILED');
        inspectOriginal(raw,taskId,a.subjects);
        verifyMaterials(a,task);
        const completedAt=new Date().toISOString();
        const event:TaskEvent={id:'historical-'+hash(taskId+':'+approvalDigest),taskId,type:'TASK_HISTORICALLY_CLOSED',actor:a.operator,
          timestamp:completedAt,details:{from:task.status,to:'DONE',kind:'HISTORICAL_CLOSED_WITH_GAPS',
            approvalDigest,normalAcceptancePassed:false,sourceAuthenticated:false,retainedGaps:[...HISTORICAL_GAPS]}};
        record={version:1,kind:'HISTORICAL_CLOSED_WITH_GAPS',normalAcceptancePassed:false,sourceAuthenticated:false,
          approval:a,approvalDigest,originalTaskUtf8:raw.toString('utf8'),completedAt,
          committedRevision:a.subjects.expectedRevision+1,outbox:{state:'PENDING',event}};
        // A successful first commit must remain readable/projectable; PROJECTED
        // may grow in both state string length and revision digit count.
        taskBytes(derived(task,record));
        const projected=structuredClone(record);projected.outbox.state='PROJECTED';
        taskBytes(derived(task,projected));
        await atomicTask(root,taskId,derived(task,record),raw,()=>{
          approval(root,taskId,approvalDigest);verifyMaterials(a,task);
        });
        return {kind:record.kind,outbox:'PENDING',taskId,revision:record.committedRevision};
      }
      if(action==='complete'){
        return {kind:record.kind,outbox:record.outbox.state,taskId,revision:task.revision};
      }
      // Only project the already committed event; never recollect or reexecute.
      await writeTaskEvent(root,record.outbox.event,true);
      if(record.outbox.state==='PROJECTED'){
        approval(root,taskId,approvalDigest);
        confirmTaskDurability(root,taskId,raw);
        return {kind:record.kind,outbox:'PROJECTED',taskId,revision:task.revision};
      }
      record.outbox.state='PROJECTED';
      const original=JSON.parse(record.originalTaskUtf8) as Task;
      await atomicTask(root,taskId,derived(original,record),raw,()=>{approval(root,taskId,approvalDigest);});
      return {kind:record.kind,outbox:'PROJECTED',taskId,revision:record.committedRevision+1};
    }));
}
