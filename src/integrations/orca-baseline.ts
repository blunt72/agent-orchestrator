import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { TextDecoder } from "node:util";
import { GitService, type FileBaselineEntry } from "../git/git-service.js";
import type { ProjectStore } from "../projects/project-store.js";
import type { OrcaBinding } from "./orca-delivery.js";
import { decodeOrcaJson } from "./orca-json.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { OrcaImportError } from "./orca-import.js";
import type { OrcaEvidenceRef } from "./orca-evidence.js";

export interface OrcaBaselineReceipt { version:1; evidence:OrcaEvidenceRef; workspaceHash:string }
interface Baseline {
  version:1; taskId:string; generation:number; bindingRevision:string; workspacePath:string;
  capturedAt:string; head:string; files:Record<string,FileBaselineEntry>; allowedFiles:string[];
  provenance:"LOCAL_PRE_BINDING_SNAPSHOT";
}
const sha = (value:string) => createHash("sha256").update(value).digest("hex");
const workspaceHash = (head:string, files:Record<string,FileBaselineEntry>) =>
  sha(JSON.stringify({head,files:Object.keys(files).sort().map(name=>[name,files[name]])}));
const validPath = (name:unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 4096 &&
  !/[\x00-\x1f\\]/.test(name) && !name.startsWith("/") && name.split("/").every(p=>p && p!=="." && p!==".." && p!==".git");
const keys = (v:object,names:string[]) => Object.keys(v).sort().join(",")===names.sort().join(",");
const invalid = () => new OrcaImportError("INVALID_BASELINE_EVIDENCE");

/** Called only by the explicit pre-binding variant while holding execution lock. */
export async function captureOrcaBindingBaseline(store:ProjectStore,binding:OrcaBinding,allowed:readonly string[]):Promise<OrcaBaselineReceipt> {
  if (!Array.isArray(allowed) || !allowed.length || allowed.length>256 || allowed.some(n=>!validPath(n)) ||
    new Set(allowed).size!==allowed.length) throw invalid();
  const before=await fingerprintOrcaWorkspace(binding.workspacePath);
  const head=await GitService.exec(["rev-parse","--verify","HEAD"],binding.workspacePath);
  if(head.exitCode!==0) throw invalid();
  const files=await GitService.captureBaseline(binding.workspacePath);
  if(Object.keys(files).some(name=>!validPath(name))) throw invalid();
  if(Object.keys(files).length>5000 || workspaceHash(head.stdout,files)!==before ||
    await fingerprintOrcaWorkspace(binding.workspacePath)!==before) throw new OrcaImportError("WORKSPACE_CHANGED");
  const baseline:Baseline={version:1,taskId:binding.agenthubTaskId,generation:binding.generation,bindingRevision:binding.revision,
    workspacePath:binding.workspacePath,capturedAt:new Date().toISOString(),head:head.stdout,files,
    allowedFiles:[...allowed].sort(),provenance:"LOCAL_PRE_BINDING_SNAPSHOT"};
  const bytes=Buffer.from(JSON.stringify(baseline),"utf8");
  if(bytes.length>262144) throw invalid();
  const evidence=await store.putOrcaEvidence(bytes);
  return {version:1,evidence,workspaceHash:before};
}

/** Read-only change attribution, not completion authority or a filesystem lock. */
export async function inspectOrcaFileAttribution(store:Pick<ProjectStore,"getTask"|"readOrcaEvidence">,taskId:string) {
  const task=await store.getTask(taskId);
  const binding=task?.orcaBinding, receipt=task?.orcaBaseline;
  if (!task || !binding || !receipt || !keys(receipt,["version","evidence","workspaceHash"]) || receipt.version!==1)
    throw new OrcaImportError("BASELINE_NOT_CAPTURED");
  const raw=await store.readOrcaEvidence(receipt.evidence);
  // Baselines use a separate bounded size limit; decodeOrcaJson intentionally stays 256 KiB.
  if(raw.length>262144) throw invalid();
  const decoded=decodeOrcaJson(new TextDecoder("utf8",{fatal:true}).decode(raw));
  const b=decoded.ok?decoded.value as Baseline:null;
  if(!b || !keys(b,["version","taskId","generation","bindingRevision","workspacePath","capturedAt","head","files","allowedFiles","provenance"]) ||
    b.version!==1 || b.taskId!==taskId || b.generation!==binding.generation || task.orcaGeneration!==binding.generation ||
    b.bindingRevision!==binding.revision || b.workspacePath!==binding.workspacePath ||
    (task.worktree??task.workspace)!==binding.workspacePath || b.provenance!=="LOCAL_PRE_BINDING_SNAPSHOT" ||
    typeof b.capturedAt!=="string" || !Number.isFinite(Date.parse(b.capturedAt)) ||
    typeof b.head!=="string" || !/^[a-f0-9]{40,64}$/.test(b.head) || !b.files || Array.isArray(b.files) || typeof b.files!=="object" ||
    Object.keys(b.files).length>5000 || !Array.isArray(b.allowedFiles) || !b.allowedFiles.length || b.allowedFiles.length>256 ||
    b.allowedFiles.some(n=>!validPath(n)) || !isDeepStrictEqual([...new Set(b.allowedFiles)].sort(),b.allowedFiles)) throw invalid();
  for(const [name,entry] of Object.entries(b.files)) {
    if(!validPath(name) || !entry || !keys(entry,["type","hash","mode"]) || !["file","symlink"].includes(entry.type) ||
      !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.mode) || entry.mode<0) throw invalid();
  }
  if(workspaceHash(b.head,b.files)!==receipt.workspaceHash) throw invalid();
  const before=await fingerprintOrcaWorkspace(binding.workspacePath);
  const head=await GitService.exec(["rev-parse","--verify","HEAD"],binding.workspacePath);
  if(head.exitCode!==0 || head.stdout!==b.head) throw new OrcaImportError("BASELINE_HEAD_CHANGED");
  const current=await GitService.captureBaseline(binding.workspacePath);
  if(workspaceHash(head.stdout,current)!==before || await fingerprintOrcaWorkspace(binding.workspacePath)!==before ||
    !isDeepStrictEqual(await store.getTask(taskId),task)) throw new OrcaImportError("ATTRIBUTION_SNAPSHOT_CHANGED");
  const changed=Array.from(new Set([...Object.keys(b.files),...Object.keys(current)])).sort()
    .filter(name=>!isDeepStrictEqual(b.files[name],current[name]));
  const outside=changed.filter(name=>!b.allowedFiles.includes(name));
  return {taskId,revision:task.revision,generation:binding.generation,workspaceHash:before,
    baselineHash:receipt.evidence.sha256,changedFiles:changed,outsideWhitelist:outside,
    changes:changed.map(file=>({file,kind:!Object.hasOwn(b.files,file)?"ADDED":!Object.hasOwn(current,file)?"DELETED":"MODIFIED"})),
    withinWhitelist:outside.length===0,scope:"LOCAL_FILE_ATTRIBUTION" as const,canCompleteTask:false as const};
}
