import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { ProjectStore } from "../projects/project-store.js";
import type { OrcaEvidenceRef } from "./orca-evidence.js";
import { validOrcaEvidenceRef } from "./orca-evidence.js";
import { captureAntigravityPrint,validGeminiPrintModel,type GeminiPrintModel } from "./antigravity-print-capture.js";
import { inspectAntigravityPrintSource } from "./antigravity-print-source.js";
import { validatedOrcaCommit, OrcaImportError } from "./orca-import.js";
import { validatedPassedOrcaTests, hashOrcaTestRun } from "./orca-review.js";
import { inspectOrcaFileAttribution } from "./orca-baseline.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { snapshotAntigravityReadPaths } from "./antigravity-read-stream.js";

const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
export interface OrcaPrintCaptureIntent {
  version:1; requestId:string; requestSha256:string; startedRevision:number;
  executable:string; evidenceRoot:string; timeoutMs:number; createdAt:string;
  profile?:{kind:"view-file-v1";allowedPaths:string[]};
  model:GeminiPrintModel;
}
export interface OrcaPrintCaptureResult {
  version:1; requestId:string; status:"CAPTURED" | "FAILED";
  evidenceDirectory:string; completedAt:string;
  files:Record<"request" | "intent" | "stdout" | "stderr" | "process",OrcaEvidenceRef>;
  sourceAuthenticated:false; canFinalizeReview:false; canCompleteTask:false;
}

// Fixed filenames under the host-selected root, not paths supplied by a model.
// Host/ancestors must be trusted; this is a local snapshot, not an OS sandbox.
function readCaptureFiles(root:string, requestId:string) {
  const directory = path.join(root,requestId);
  const snapshot = fs.lstatSync(directory,{bigint:true});
  if (fs.realpathSync(root) !== root || fs.realpathSync(directory) !== directory || !snapshot.isDirectory() ||
      snapshot.uid !== BigInt(process.getuid!()) || (snapshot.mode & 0o022n)) throw new Error("UNSAFE_CAPTURE_DIRECTORY");
  const result = {} as Record<"request" | "intent" | "stdout" | "stderr" | "process",Buffer>;
  for(const [key,name,max] of [["request","request.bin",65536],["intent","intent.json",32768],
    ["stdout","stdout.bin",4194304],["stderr","stderr.bin",65536],["process","process.json",32768]] as const) {
    const file = path.join(directory,name), before = fs.lstatSync(file,{bigint:true});
    const same = (a:typeof before,b:typeof before) => a.dev===b.dev && a.ino===b.ino && a.size===b.size &&
      a.mode===b.mode && a.uid===b.uid && a.nlink===b.nlink && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs;
    if(!before.isFile() || before.nlink!==1n || before.uid!==BigInt(process.getuid!()) || (before.mode & 0o022n) || before.size>BigInt(max)) throw new Error("UNSAFE_CAPTURE_FILE");
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
      if(!same(before,fs.fstatSync(fd,{bigint:true}))) throw new Error("CAPTURE_FILE_CHANGED");
      const bytes=Buffer.alloc(Number(before.size)+1);let count=0,n=0;
      while(count<bytes.length && (n=fs.readSync(fd,bytes,count,bytes.length-count,count))>0) count+=n;
      if(count!==Number(before.size) || !same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(file,{bigint:true}))) throw new Error("CAPTURE_FILE_CHANGED");
      result[key]=Buffer.from(bytes.subarray(0,count));
    } finally {fs.closeSync(fd);}
  }
  const after=fs.lstatSync(directory,{bigint:true});
  if(snapshot.dev!==after.dev || snapshot.ino!==after.ino || snapshot.mode!==after.mode || snapshot.uid!==after.uid ||
      snapshot.mtimeNs!==after.mtimeNs || snapshot.ctimeNs!==after.ctimeNs || fs.realpathSync(directory)!==directory) throw new Error("CAPTURE_DIRECTORY_CHANGED");
  return result;
}

/** Explicit operator capture. Stores launch intent before starting a process;
 * unknown outcomes consume the attempt. No verdict or DONE is written.
 */
export async function capturePreparedOrcaPrintReview(store:ProjectStore,taskId:string,
  approval:{revision:number;requestId:string;requestSha256:string},
  configuration:{executable:string;evidenceRoot:string;timeoutMs?:number;readOnlyPaths?:readonly string[];model?:GeminiPrintModel}) {
  return capture(store,taskId,approval,configuration,false);
}
export async function capturePreparedOrcaPrintRecovery(store:ProjectStore,taskId:string,
  approval:{revision:number;requestId:string;requestSha256:string},
  configuration:{executable:string;evidenceRoot:string;timeoutMs?:number;readOnlyPaths?:readonly string[];model?:GeminiPrintModel}) {
  return capture(store,taskId,approval,configuration,true);
}
async function capture(store:ProjectStore,taskId:string,
  approval:{revision:number;requestId:string;requestSha256:string},
  configuration:{executable:string;evidenceRoot:string;timeoutMs?:number;readOnlyPaths?:readonly string[];model?:GeminiPrintModel},recovery:boolean) {
  const a=structuredClone(approval),c=structuredClone(configuration);
  const model=c.model===undefined?"gemini-3.8-flash-high":c.model;
  if(!validGeminiPrintModel(model))throw new Error("INVALID_PRINT_MODEL");
  if(!Number.isSafeInteger(a.revision) || a.revision<1 || a.revision>=Number.MAX_SAFE_INTEGER ||
      typeof a.requestId!=="string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(a.requestId) ||
      typeof a.requestSha256!=="string" || !/^[a-f0-9]{64}(?![\s\S])/.test(a.requestSha256)) throw new OrcaImportError("INVALID_PRINT_CAPTURE_APPROVAL");
  return store.runTaskExecutionExclusive(taskId,async()=> {
    const task=await store.getTask(taskId),commit=validatedOrcaCommit(task),b=task!.orcaBinding!;
    const intentKey=recovery?"orcaPrintRecoveryCaptureIntent":"orcaPrintCaptureIntent";
    const resultKey=recovery?"orcaPrintRecoveryCaptureResult":"orcaPrintCaptureResult";
    const r=task!.orcaPrintRecoveryPreparation,p=recovery?r?.preparation:task!.orcaPrintReviewPreparation;
    if(recovery&&(!r||task!.orcaPrintCaptureResult?.status!=="FAILED"||task!.orcaPrintReviewFinalization||
        r.previousRequestId!==task!.orcaPrintReviewPreparation?.requestId||
        sha(JSON.stringify(task!.orcaPrintCaptureResult))!==r.failedCaptureHash||!c.readOnlyPaths))throw new OrcaImportError("PRINT_RECOVERY_NOT_READY");
    if(!p || (!recovery&&r) || task![intentKey] || task![resultKey] || task!.orcaReviewRun || task!.status!=="REVIEW" || task!.result!==undefined ||
        task!.revision!==a.revision || p.preparedRevision!==a.revision || p.requestId!==a.requestId || p.request.sha256!==a.requestSha256 ||
        p.adapter!=="antigravity-print" || p.phase!=="PREPARED" || p.subjects.taskId!==taskId || p.subjects.digest!==commit.digest ||
        p.subjects.generation!==commit.generation || commit.outbox.state!=="PROJECTED" || sha(JSON.stringify(b))!==p.bindingHash ||
        b.developer!=="codex" || b.reviewer!=="gemini" || task!.owner!==b.developer || task!.ownerId!==b.ownerId ||
        task!.ownerType!=="AGENT" || (task!.reviewerId??task!.reviewer)!==b.reviewer || (task!.claim?.id??null)!==b.claimId)
      throw new OrcaImportError("PRINT_CAPTURE_NOT_READY");
    const tests=validatedPassedOrcaTests(task!);
    if(hashOrcaTestRun(tests)!==p.subjects.testRunHash || tests.id!==p.subjects.testRunId || tests.workspaceHash!==p.subjects.workspaceHash)
      throw new OrcaImportError("STALE_TEST_RECEIPT");
    for(const ref of [p.requirements,p.testOutput,p.baseline]) {if(!validOrcaEvidenceRef(ref)) throw new Error("INVALID_PRINT_EVIDENCE");await store.readOrcaEvidence(ref);}
    if(!validOrcaEvidenceRef(p.request) || p.request.bytes>65536) throw new Error("INVALID_PRINT_REQUEST");
    const request=await store.readOrcaEvidence(p.request),prompt=new TextDecoder("utf-8",{fatal:true}).decode(request);
    const attribution=await inspectOrcaFileAttribution(store,taskId);
    if(!attribution.withinWhitelist || attribution.workspaceHash!==p.subjects.workspaceHash) throw new OrcaImportError("PRINT_CAPTURE_WORKSPACE_CHANGED");
    const profile=c.readOnlyPaths===undefined?undefined:{kind:"view-file-v1" as const,allowedPaths:snapshotAntigravityReadPaths(c.readOnlyPaths)};
    if(profile&&(attribution.changes.some(change=>change.kind==="DELETED")||
        !isDeepStrictEqual(profile.allowedPaths,attribution.changedFiles.map(file=>path.join(b.workspacePath,file)).sort())))
      throw new OrcaImportError("PRINT_READ_SCOPE_MISMATCH");
    if(profile)for(const file of profile.allowedPaths){
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid!()||(stat.mode&0o022)||stat.size>1048576||fs.realpathSync(file)!==file)
        throw new OrcaImportError("UNSAFE_PRINT_READ_FILE");
    }
    for(const name of [c.executable,c.evidenceRoot]) if(typeof name!=="string" || !path.isAbsolute(name) || fs.realpathSync(name)!==name) throw new Error("INVALID_CAPTURE_PATH");
    const timeoutMs=c.timeoutMs??120000;
    if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>600000) throw new Error("INVALID_CAPTURE_TIMEOUT");
    if(await fingerprintOrcaWorkspace(b.workspacePath)!==p.subjects.workspaceHash || !isDeepStrictEqual(await store.getTask(taskId),task)) throw new Error("PRINT_CAPTURE_SNAPSHOT_CHANGED");
    const intent:OrcaPrintCaptureIntent={version:1,requestId:p.requestId,requestSha256:p.request.sha256,startedRevision:a.revision+1,
      executable:c.executable,evidenceRoot:c.evidenceRoot,timeoutMs,model,createdAt:new Date().toISOString(),...(profile?{profile}:{})};
    task![intentKey]=intent;await store.saveTask(task!);
    if(!isDeepStrictEqual(await store.getTask(taskId),task)) throw new Error("PRINT_CAPTURE_START_CHANGED");
    const captured=await captureAntigravityPrint({executable:c.executable,evidenceRoot:c.evidenceRoot,cwd:b.workspacePath,
      requestId:p.requestId,prompt,timeoutMs,model,...(profile?{readOnlyPaths:profile.allowedPaths}:{})});
    const bytes=readCaptureFiles(c.evidenceRoot,p.requestId);
    const files={} as OrcaPrintCaptureResult["files"];
    // Retain every original file even if parsing, workspace or task checks fail.
    for(const key of ["request","intent","stdout","stderr","process"] as const) files[key]=await store.putOrcaEvidence(bytes[key]);
    if(captured.status==="CAPTURED") inspectAntigravityPrintSource(bytes.request,bytes.intent,bytes.stdout,bytes.stderr,bytes.process,
      JSON.stringify({requestId:p.requestId,cwd:b.workspacePath,executable:c.executable,requestSha256:p.request.sha256,model,...(profile?{profile}:{})}));
    const result:OrcaPrintCaptureResult={version:1,requestId:p.requestId,status:captured.status,evidenceDirectory:path.join(c.evidenceRoot,p.requestId),
      completedAt:new Date().toISOString(),files,sourceAuthenticated:false,canFinalizeReview:false,canCompleteTask:false};
    // A cancellation/reassignment wins. The original files remain available but
    // a stale task snapshot is never saved over the administrative change.
    if(!isDeepStrictEqual(await store.getTask(taskId),task)) throw new Error("PRINT_CAPTURE_TASK_CHANGED_OR_CANCELLED");
    task![resultKey]=result;await store.saveTask(task!);
    return structuredClone(result);
  });
}
