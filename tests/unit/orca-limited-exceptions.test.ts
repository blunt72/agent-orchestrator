import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {inspectOrcaLimitedExceptions} from "../../src/integrations/orca-limited-exceptions.js";
import {parseOrcaCompletionBinding} from "../../src/integrations/orca-evidence-manifest.js";
const sha=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
function fixture(){
 const binding={agenthubTaskId:"task",projectId:"project",revision:"2",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",dispatchId:"dispatch",workspaceId:"workspace",workspacePath:"/workspace",terminalHandle:"terminal",developer:"gemini",reviewer:"codex",provider:"antigravity",ownerId:"gemini",claimId:null};
 const rawBinding=JSON.stringify(binding);
 const receipt={ok:true,_meta:{runtimeId:"runtime"},result:{dispatch:{id:"dispatch",runId:"run",taskId:"orca-task",status:"completed",assigneeHandle:"terminal"},worker:{dispatchId:"dispatch",runtimeEpoch:"runtime",state:"succeeded",stage:"settled",agentTerminalHandle:"terminal"},projection:{dispatchId:"dispatch",runId:"run",taskId:"orca-task",outcome:"succeeded",resource:{state:"user_owned",releaseState:"retained"}},terminalResource:{ownershipState:"user_owned",releaseState:"retained",retainedReason:"user_takeover",originDispatchId:"dispatch",ownerDispatchId:"dispatch",terminalHandle:"terminal",endpointId:"runtime"},terminal:{handle:"terminal",worktreePath:"/workspace"}}};
 Object.assign(receipt.result.projection.resource,{id:"resource"});
 Object.assign(receipt.result.terminalResource,{id:"resource",worktreeId:"workspace"});
 Object.assign(receipt.result.worker,{worktreeId:"workspace"});
 Object.assign(receipt.result.terminal,{worktreeId:"workspace"});
 const current={revision:19,workspaceHash:"a".repeat(64),outsideWhitelist:[".DS_Store"],metadata:{type:"file",hash:"b".repeat(64),mode:33188}};
 const policy={version:1,purpose:"LIMITED_METADATA_AND_RETAINED_TERMINAL_EVIDENCE",taskId:"task",revision:19,bindingDigest:parseOrcaCompletionBinding(rawBinding).digest,workspaceDigest:current.workspaceHash,metadata:{hash:current.metadata.hash,mode:current.metadata.mode},cleanup:{sha256:"",bytes:0}};
 function inspect(){const cleanup=Buffer.from(JSON.stringify({exit_code:0,output:JSON.stringify(receipt)}));policy.cleanup={sha256:sha(cleanup),bytes:cleanup.length};const raw=JSON.stringify(policy);return inspectOrcaLimitedExceptions(raw,sha(raw),rawBinding,current,cleanup);}
 return {binding,rawBinding,receipt,current,policy,inspect};
}
describe("limited exceptions (synthetic consistency only)",()=>{
 it.each(["executionHostId","agentIdentity"])("rejects conflicting terminal %s with recomputed pins",key=>{
  const f=fixture();Object.assign(f.receipt.result.terminal,{[key]:"other"});expect(f.inspect).toThrow();
 });
 it.each(["host","provider","workspace","role","stage","launch"])("rejects conflicting optional identity %s",kind=>{
  const f=fixture(),r=f.receipt.result;
  if(kind==="host")Object.assign(r.dispatch,{hostScope:{kind:"local",hostId:"other"}});
  if(kind==="provider")Object.assign(r.projection,{provider:{id:"other"}});
  if(kind==="workspace")Object.assign(r.projection,{workspace:{id:"other"}});
  if(kind==="role")Object.assign(r.projection,{role:"other"});
  if(kind==="stage")Object.assign(r.projection,{stage:{dispatch:"dispatched",worker:"succeeded"}});
  if(kind==="launch")Object.assign(r.worker,{startOptions:{launch:{effective:{agent:"other"}}}});
  expect(f.inspect).toThrow();
 });
 it("rejects conflicting task_id alias with recomputed pins",()=>{
  const f=fixture();Object.assign(f.receipt.result.dispatch,{task_id:"other"});expect(f.inspect).toThrow();
 });
 it.each(["id","ownerDispatchId","originDispatchId","terminalHandle","worktreeId","endpointId","endpointIncarnation"])("rejects contradictory projected resource %s with recomputed pins",key=>{
  const f=fixture();Object.assign(f.receipt.result.projection.resource,{[key]:"conflict"});expect(f.inspect).toThrow();
 });
 it("accepts exact evidence without granting completion or claiming release",()=>{
  expect(fixture().inspect()).toMatchObject({exceptionEvidenceConsistent:true,canCompleteTask:false,terminalReleased:false,metadataWhitelistExpanded:false,currentLivenessVerified:false});
 });
 it.each(["task","revision","workspace","metadata-hash","metadata-mode","extra-file","no-exception"])("rejects scope drift %s",kind=>{
  const f=fixture();
  if(kind==="task")f.policy.taskId="other";
  if(kind==="revision")f.current.revision++;
  if(kind==="workspace")f.current.workspaceHash="c".repeat(64);
  if(kind==="metadata-hash")f.current.metadata.hash="c".repeat(64);
  if(kind==="metadata-mode")f.current.metadata.mode++;
  if(kind==="extra-file")f.current.outsideWhitelist.push("src/errors.ts");
  if(kind==="no-exception")f.current.outsideWhitelist=[];
  expect(f.inspect).toThrow();
 });
 it.each(["dispatch","runtime","owner","reason","released","failed-worker","workspace","terminal","projection"])("rejects inconsistent cleanup %s even with recomputed byte pins",kind=>{
  const f=fixture(),r=f.receipt.result;
  if(kind==="dispatch")r.dispatch.id="other";
  if(kind==="runtime")f.receipt._meta.runtimeId="other";
  if(kind==="owner")r.terminalResource.ownerDispatchId="other";
  if(kind==="reason")r.terminalResource.retainedReason="other";
  if(kind==="released")r.terminalResource.releaseState="released";
  if(kind==="failed-worker")r.worker.state="failed";
  if(kind==="workspace")r.terminal.worktreePath="/other";
  if(kind==="terminal")r.terminal.handle="other";
  if(kind==="projection")r.projection.resource.state="managed";
  expect(f.inspect).toThrow();
 });
 it("rejects bad pins, excess bytes, duplicate keys and invalid UTF-8",()=>{
  const f=fixture();f.inspect();
  const raw=JSON.stringify(f.policy),bytes=Buffer.from('{}');
  expect(()=>inspectOrcaLimitedExceptions(raw,"0".repeat(64),f.rawBinding,f.current,bytes)).toThrow();
  expect(()=>inspectOrcaLimitedExceptions(raw,sha(raw),f.rawBinding,f.current,Buffer.alloc(262145))).toThrow();
  const duplicate=raw.replace('"version":1','"version":1,"version":1');
  expect(()=>inspectOrcaLimitedExceptions(duplicate,sha(duplicate),f.rawBinding,f.current,bytes)).toThrow();
  const invalid=Buffer.from([255]);f.policy.cleanup={sha256:sha(invalid),bytes:invalid.length};const p=JSON.stringify(f.policy);
  expect(()=>inspectOrcaLimitedExceptions(p,sha(p),f.rawBinding,f.current,invalid)).toThrow();
 });
});
