import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { inspectOrcaExecutionPermission, type OrcaExecutionPermissionExpectation } from "./orca-execution-permission.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

export const releaseHash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
export const releaseFail=(code:string):never=>{throw Error(code);};
export const releaseExact=(v:unknown,keys:string[]):v is Record<string,any>=>
  !!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===[...keys].sort().join(",");
export const releaseDigest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}(?![\s\S])/.test(v);
export function releaseJson(bytes:Buffer):unknown {
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>32768)return releaseFail("INVALID_RELEASE_BYTES");
  const parsed=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if(!parsed.ok)return releaseFail("INVALID_RELEASE_JSON");
  return parsed.value;
}
const timestamp=(v:unknown):v is string=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export interface ReleaseMaterial {
  request:Buffer; permission:Buffer; rawBinding:string; rawPolicy:string;
  expected:OrcaExecutionPermissionExpectation & {enrollmentDigest:string};
}
export function snapshotReleaseMaterial(input:ReleaseMaterial):ReleaseMaterial {
  releaseJson(input.request);releaseJson(input.permission);
  if(typeof input.rawBinding!=="string"||Buffer.byteLength(input.rawBinding)>32768||
    typeof input.rawPolicy!=="string"||Buffer.byteLength(input.rawPolicy)>32768)return releaseFail("INVALID_RELEASE_MATERIAL");
  return {...input,request:Buffer.from(input.request),permission:Buffer.from(input.permission),expected:structuredClone(input.expected)};
}
export function inspectReleaseMaterial(m:ReleaseMaterial){
  const r=releaseJson(m.request);
  if(!releaseExact(r,["version","purpose","decision","requestId","permissionSha256","enrollmentDigest","replyBodySha256","issuedAt","expiresAt"])||
    r.version!==1||r.purpose!=="TASK_SCOPED_ORCA_EXECUTION_RELEASE_REQUEST"||r.decision!=="NOT_APPROVED"||
    typeof r.requestId!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(r.requestId)||
    ![r.permissionSha256,r.enrollmentDigest,r.replyBodySha256].every(releaseDigest)||
    !timestamp(r.issuedAt)||!timestamp(r.expiresAt)||Date.parse(r.expiresAt)<=Date.parse(r.issuedAt)||
    Date.parse(r.expiresAt)-Date.parse(r.issuedAt)>900000)return releaseFail("INVALID_RELEASE_REQUEST");
  const {enrollmentDigest,...e}=m.expected;
  inspectOrcaExecutionPermission(m.rawBinding,m.permission,e);
  if(r.permissionSha256!==e.permissionSha256||r.enrollmentDigest!==enrollmentDigest)return releaseFail("RELEASE_SCOPE_MISMATCH");
  const {binding,digest}=parseOrcaCompletionBinding(m.rawBinding);
  const identity={runtimeId:binding.runtimeId,runId:binding.runId,orcaTaskId:binding.taskId,dispatchId:binding.dispatchId,
    terminalHandle:binding.terminalHandle,workerIncarnation:e.workerIncarnation,resourceId:e.resourceId,questionId:e.questionId};
  return {request:r,requestSha256:releaseHash(m.request),taskId:binding.agenthubTaskId,taskRevision:e.taskRevision,
    bindingDigest:digest,identity,operator:structuredClone(e.operator)};
}
export function inspectReleaseApproval(bytes:Buffer,context:ReturnType<typeof inspectReleaseMaterial>,now:number){
  const a=releaseJson(bytes);
  if(!releaseExact(a,["version","purpose","decision","requestSha256","approvedAt","operator"])||a.version!==1||
    a.purpose!=="TASK_SCOPED_ORCA_EXECUTION_RELEASE_APPROVAL"||a.decision!=="APPROVED"||
    a.requestSha256!==context.requestSha256||!isDeepStrictEqual(a.operator,context.operator)||
    !timestamp(a.approvedAt)||Date.parse(a.approvedAt)<Date.parse(context.request.issuedAt)||Date.parse(a.approvedAt)>now)
    return releaseFail("INVALID_RELEASE_APPROVAL");
  // Matching local JSON is not proof of a human decision; the caller must supply a trusted verifier.
  return {approvalSha256:releaseHash(bytes),approvedAt:a.approvedAt};
}
export function inspectReleaseObservation(value:unknown,identity:ReturnType<typeof inspectReleaseMaterial>["identity"]){
  if(!releaseExact(value,[...Object.keys(identity),"ownership","retained","dispatchActive","questionPending"])||
    Object.entries(identity).some(([k,v])=>value[k]!==v)||value.ownership!=="managed"||value.retained!==false||
    value.dispatchActive!==true||value.questionPending!==true)return releaseFail("RELEASE_OBSERVATION_REJECTED");
}
export function inspectExecutionReplyReceipt(value:unknown,context:ReturnType<typeof inspectReleaseMaterial>){
  const expected={runId:context.identity.runId,dispatchId:context.identity.dispatchId,
    questionId:context.identity.questionId,replyBodySha256:context.request.replyBodySha256};
  if(!releaseExact(value,[...Object.keys(expected),"messageId"])||
    Object.entries(expected).some(([k,v])=>value[k]!==v)||typeof value.messageId!=="string"||
    !/^msg_[a-f0-9]{12}(?![\s\S])/.test(value.messageId))return releaseFail("INVALID_EXECUTION_REPLY_RECEIPT");
  return {...expected,messageId:value.messageId};
}
