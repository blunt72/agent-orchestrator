import { createHash } from "node:crypto";
import { decodeOrcaJson } from "./orca-json.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (): never => { throw new Error("INVALID_LIMITED_EXCEPTION_EVIDENCE"); };
const exact = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === keys.sort().join(",");
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v);

/** Pure local consistency check. A pin or retained receipt does not grant approval. */
export function inspectOrcaLimitedExceptions(rawPolicy: string, expectedDigest: string, rawBinding: string,
  current: {revision: number; workspaceHash: string; outsideWhitelist: string[]; metadata: {type: string; hash: string; mode: number}},
  cleanupBytes: Buffer) {
  if (typeof rawPolicy !== "string" || Buffer.byteLength(rawPolicy) > 32768 || !hash(expectedDigest) || sha(rawPolicy) !== expectedDigest ||
      !Buffer.isBuffer(cleanupBytes) || cleanupBytes.length > 262144) fail();
  const decoded = decodeOrcaJson(rawPolicy);
  const p = decoded.ok ? decoded.value : null;
  if (!exact(p,["version","purpose","taskId","revision","bindingDigest","workspaceDigest","metadata","cleanup"])) return fail();
  if (p.version !== 1 || p.purpose !== "LIMITED_METADATA_AND_RETAINED_TERMINAL_EVIDENCE" ||
      !Number.isSafeInteger(p.revision) || p.revision < 1 || !hash(p.bindingDigest) || !hash(p.workspaceDigest) ||
      !exact(p.metadata,["hash","mode"]) || !hash(p.metadata.hash) || !Number.isSafeInteger(p.metadata.mode) || p.metadata.mode < 0 ||
      !exact(p.cleanup,["sha256","bytes"]) || !hash(p.cleanup.sha256) || !Number.isSafeInteger(p.cleanup.bytes) ||
      p.cleanup.bytes !== cleanupBytes.length || sha(cleanupBytes) !== p.cleanup.sha256) fail();
  const {binding,digest}=parseOrcaCompletionBinding(rawBinding);
  if (p.taskId !== binding.agenthubTaskId || p.bindingDigest !== digest || !current || current.revision !== p.revision ||
      current.workspaceHash !== p.workspaceDigest || !Array.isArray(current.outsideWhitelist) ||
      current.outsideWhitelist.length !== 1 || current.outsideWhitelist[0] !== ".DS_Store" ||
      !exact(current.metadata,["type","hash","mode"]) || current.metadata.type !== "file" ||
      current.metadata.hash !== p.metadata.hash || current.metadata.mode !== p.metadata.mode) fail();
  const wrapper = decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(cleanupBytes));
  const w = wrapper.ok ? wrapper.value as any : null;
  if (!w || w.exit_code !== 0 || typeof w.output !== "string" || Buffer.byteLength(w.output) > 262144) fail();
  const parsed = decodeOrcaJson(w.output);
  const receipt = parsed.ok ? parsed.value as any : null;
  const r=receipt?.result, resource=r?.terminalResource;
  const projected=r?.projection?.resource;
  if(typeof resource?.id!=="string"||resource.id.length===0||projected?.id!==resource.id||
     resource.worktreeId!==binding.workspaceId||r?.worker?.worktreeId!==binding.workspaceId||r?.terminal?.worktreeId!==binding.workspaceId)return fail();
  for(const key of ["ownerDispatchId","originDispatchId","terminalHandle","worktreeId","endpointId","endpointIncarnation"]){
    if(projected[key]!==undefined&&projected[key]!==resource[key])return fail();
  }
  const optionalIdentities:[unknown,unknown][]=[
    [r?.terminal?.executionHostId,binding.hostId],[r?.terminal?.agentIdentity,binding.provider],
    [r?.dispatch?.task_id,binding.taskId],[r?.dispatch?.contractVersion,1],
    [r?.dispatch?.hostScope?.kind,"local"],[r?.dispatch?.hostScope?.hostId,binding.hostId],
    [r?.worker?.startOptions?.agent,binding.provider],[r?.worker?.startOptions?.resolvedWorktreeId,binding.workspaceId],
    [r?.worker?.startOptions?.launch?.effective?.agent,binding.provider],
    [r?.projection?.id,binding.dispatchId],[r?.projection?.role,"worker"],
    [r?.projection?.host?.kind,"local"],[r?.projection?.host?.id,binding.hostId],
    [r?.projection?.workspace?.id,binding.workspaceId],[r?.projection?.provider?.id,binding.provider],
    [r?.projection?.stage?.dispatch,"completed"],[r?.projection?.stage?.worker,"succeeded"],
    [r?.projection?.evidence?.durable,true],[projected?.terminalState,"retained"],
  ];
  if(optionalIdentities.some(([observed,expected])=>observed!==undefined&&observed!==expected))return fail();
  if (receipt?.ok !== true || receipt?._meta?.runtimeId !== binding.runtimeId ||
      r?.dispatch?.id !== binding.dispatchId || r.dispatch.runId !== binding.runId || r.dispatch.taskId !== binding.taskId ||
      (r.dispatch.task_id!==undefined&&r.dispatch.task_id!==binding.taskId) ||
      r.dispatch.status !== "completed" || r.dispatch.assigneeHandle !== binding.terminalHandle ||
      r.worker?.dispatchId !== binding.dispatchId || r.worker.runtimeEpoch !== binding.runtimeId ||
      r.worker.state !== "succeeded" || r.worker.stage !== "settled" || r.worker.agentTerminalHandle !== binding.terminalHandle ||
      r.projection?.dispatchId !== binding.dispatchId || r.projection.runId !== binding.runId || r.projection.taskId !== binding.taskId ||
      r.projection.outcome !== "succeeded" || r.projection.resource?.state !== "user_owned" ||
      r.projection.resource.releaseState !== "retained" || resource?.ownershipState !== "user_owned" ||
      resource.releaseState !== "retained" || resource.retainedReason !== "user_takeover" ||
      resource.originDispatchId !== binding.dispatchId || resource.ownerDispatchId !== binding.dispatchId ||
      resource.terminalHandle !== binding.terminalHandle || resource.endpointId !== binding.runtimeId ||
      r.terminal?.handle !== binding.terminalHandle || r.terminal.worktreePath !== binding.workspacePath) fail();
  return {taskId:binding.agenthubTaskId,revision:p.revision,policyDigest:expectedDigest,exceptionEvidenceConsistent:true as const,
    metadataWhitelistExpanded:false as const,terminalReleased:false as const,currentLivenessVerified:false as const,
    sourceAuthenticated:false as const,canCompleteTask:false as const,scope:"LIMITED_EXCEPTION_EVIDENCE_ONLY" as const};
}
