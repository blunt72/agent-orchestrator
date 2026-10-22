import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const fail=():never=>{throw Error("INVALID_RETAINED_TERMINAL_EVIDENCE");};
const digest=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}(?![\s\S])/.test(v);
function decode(bytes:Buffer){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>262144)return fail();
  const p=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes));return p.ok?p.value as any:fail();
}

/** Historical supplied receipt consistency only; never live status or release authority. */
export function inspectOrcaRetainedTerminalEvidence(rawBinding:string,settlement:Buffer,release:Buffer,
  expectation:{settlementSha256:string;releaseSha256:string;workerIncarnation:string}){
  const e=structuredClone(expectation);
  if(!digest(e.settlementSha256)||!digest(e.releaseSha256)||typeof e.workerIncarnation!=="string"||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(e.workerIncarnation))return fail();
  const s=decode(settlement),l=decode(release),{binding:b,digest:bindingDigest}=parseOrcaCompletionBinding(rawBinding);
  if(sha(settlement)!==e.settlementSha256||sha(release)!==e.releaseSha256)return fail();
  const r=s?.result,d=r?.dispatch,w=r?.worker,p=r?.projection,t=r?.terminal,x=r?.terminalResource,c=l?.result;
  if(s?.ok!==true||l?.ok!==true||s?._meta?.runtimeId!==b.runtimeId||l?._meta?.runtimeId!==b.runtimeId||
      d?.id!==b.dispatchId||d.runId!==b.runId||d.taskId!==b.taskId||d.assigneeHandle!==b.terminalHandle||d.status!=="completed"||
      w?.dispatchId!==b.dispatchId||w.runtimeEpoch!==b.runtimeId||w.agentTerminalHandle!==b.terminalHandle||w.worktreeId!==b.workspaceId||
      w.state!=="succeeded"||w.stage!=="settled"||p?.dispatchId!==b.dispatchId||p.runId!==b.runId||p.taskId!==b.taskId||
      p.outcome!=="succeeded"||p.resource?.state!=="user_owned"||p.resource.releaseState!=="retained"||
      t?.handle!==b.terminalHandle||t.worktreeId!==b.workspaceId||t.worktreePath!==b.workspacePath||t.incarnationId!==e.workerIncarnation||
      x?.ownershipState!=="user_owned"||x.releaseState!=="retained"||x.retainedReason!=="user_takeover"||
      x.terminalHandle!==b.terminalHandle||x.worktreeId!==b.workspaceId||x.endpointId!==b.runtimeId||
      x.ownerDispatchId!==b.dispatchId||x.originDispatchId!==b.dispatchId||typeof x.id!=="string"||!x.id||p.resource.id!==x.id||
      typeof x.endpointIncarnation!=="string"||x.endpointIncarnation!==`${t.ptyId}:${e.workerIncarnation}`||typeof t.ptyId!=="string"||!t.ptyId||
      c?.dispatchId!==b.dispatchId||c.state!=="retained"||c.reason!=="user_takeover"||c.processAction!=="none"||c.archive!==null)return fail();
  const optional:[unknown,unknown][]=[
    [d.task_id,b.taskId],[d.hostScope?.kind,"local"],[d.hostScope?.hostId,b.hostId],
    [w.startOptions?.agent,b.provider],[w.startOptions?.resolvedWorktreeId,b.workspaceId],
    [w.startOptions?.launch?.effective?.agent,b.provider],[p.id,b.dispatchId],[p.role,"worker"],
    [p.host?.kind,"local"],[p.host?.id,b.hostId],
    [p.workspace?.id,b.workspaceId],[p.provider?.id,b.provider],[p.stage?.dispatch,"completed"],[p.stage?.worker,"succeeded"],
    [p.resource?.ownerDispatchId,b.dispatchId],[p.resource?.terminalState,"retained"],
    [t.executionHostId,b.hostId],[t.agentIdentity,b.provider],
    [x.archive?.source,null],[x.archive?.status,null],
  ];
  for(const key of ["ownerDispatchId","originDispatchId","terminalHandle","worktreeId","endpointId","endpointIncarnation"])
    optional.push([p.resource?.[key],x[key]]);
  if(optional.some(([observed,expected])=>observed!==undefined&&observed!==expected))return fail();
  return {taskId:b.agenthubTaskId,bindingDigest,dispatchId:b.dispatchId,workerIncarnation:e.workerIncarnation,
    resourceId:x.id as string,settlementSha256:e.settlementSha256,releaseSha256:e.releaseSha256,
    retainedEvidenceConsistent:true,terminalReleased:false,currentLivenessVerified:false,chronologyVerified:false,
    sourceAuthenticated:false,approvalIssued:false,canCompleteTask:false,scope:"HISTORICAL_USER_OWNED_RETAINED_TERMINAL_EVIDENCE"};
}
