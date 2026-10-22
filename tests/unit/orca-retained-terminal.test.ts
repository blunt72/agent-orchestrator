import { createHash } from "node:crypto";
import { expect,it } from "vitest";
import { inspectOrcaRetainedTerminalEvidence } from "../../src/integrations/orca-retained-terminal.js";
const incarnation="11111111-1111-4111-8111-111111111111";
const b={agenthubTaskId:"task",projectId:"project",revision:"4",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",
  dispatchId:"dispatch",workspaceId:"workspace",workspacePath:"/workspace",terminalHandle:"terminal",developer:"codex",reviewer:"gemini",provider:"codex",ownerId:"codex",claimId:null};
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
const hash=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
function fixture(){return {s:{ok:true,_meta:{runtimeId:"runtime"},result:{
  dispatch:{id:"dispatch",runId:"run",taskId:"orca-task",assigneeHandle:"terminal",status:"completed"},
  worker:{dispatchId:"dispatch",runtimeEpoch:"runtime",agentTerminalHandle:"terminal",worktreeId:"workspace",state:"succeeded",stage:"settled"},
  projection:{dispatchId:"dispatch",runId:"run",taskId:"orca-task",outcome:"succeeded",resource:{id:"resource",state:"user_owned",releaseState:"retained"}},
  terminal:{handle:"terminal",worktreeId:"workspace",worktreePath:"/workspace",incarnationId:incarnation,ptyId:"pty"},
  terminalResource:{id:"resource",ownershipState:"user_owned",releaseState:"retained",retainedReason:"user_takeover",terminalHandle:"terminal",
    worktreeId:"workspace",endpointId:"runtime",endpointIncarnation:`pty:${incarnation}`,ownerDispatchId:"dispatch",originDispatchId:"dispatch"},
}},l:{ok:true,_meta:{runtimeId:"runtime"},result:{dispatchId:"dispatch",state:"retained",reason:"user_takeover",processAction:"none",archive:null}}};}
function run(f=fixture()){
  const s=encode(f.s),l=encode(f.l);return inspectOrcaRetainedTerminalEvidence(JSON.stringify(b),s,l,{settlementSha256:hash(s),releaseSha256:hash(l),workerIncarnation:incarnation});
}
it("matches synthetic historical retained receipts without granting release or completion",()=>{
  const r=run();expect(r.retainedEvidenceConsistent).toBe(true);
  for(const key of ["terminalReleased","currentLivenessVerified","chronologyVerified","sourceAuthenticated","approvalIssued","canCompleteTask"] as const)expect(r[key]).toBe(false);
});
it.each(["runtime","dispatch","worker","incarnation","endpoint","owner","resource","released","process","archive","provider"])("rejects mismatched %s",kind=>{
  const f=fixture();
  if(kind==="runtime")f.l._meta.runtimeId="other";
  if(kind==="dispatch")f.s.result.dispatch.runId="other";
  if(kind==="worker")f.s.result.worker.state="failed";
  if(kind==="incarnation")f.s.result.terminal.incarnationId="other";
  if(kind==="endpoint")f.s.result.terminalResource.endpointIncarnation="other";
  if(kind==="owner")f.s.result.terminalResource.ownerDispatchId="other";
  if(kind==="resource")f.s.result.projection.resource.id="other";
  if(kind==="released")f.l.result.state="released";
  if(kind==="process")f.l.result.processAction="closed_agent_terminal";
  if(kind==="archive")(f.l.result as any).archive={source:"terminal",status:"captured"};
  if(kind==="provider")(f.s.result.terminal as any).agentIdentity="other";
  expect(()=>run(f)).toThrow();
});
it("rejects invalid input and hash mismatches",()=>{
  const f=fixture(),s=encode(f.s),l=encode(f.l),e={settlementSha256:hash(s),releaseSha256:hash(l),workerIncarnation:incarnation};
  for(const bad of [Buffer.alloc(262145),Buffer.from([255]),Buffer.from('{"ok":true,"ok":true}')])
    expect(()=>inspectOrcaRetainedTerminalEvidence(JSON.stringify(b),bad,l,e)).toThrow();
  expect(()=>inspectOrcaRetainedTerminalEvidence(JSON.stringify(b),s,l,{...e,settlementSha256:"b".repeat(64)})).toThrow();
});
it.each(["ownerDispatchId","originDispatchId","terminalHandle","worktreeId","endpointId","endpointIncarnation"])("rejects contradictory projected %s with recomputed pins",key=>{
  const f=fixture();(f.s.result.projection.resource as any)[key]="other";expect(()=>run(f)).toThrow();
});
it.each(["id","role","resolvedWorktreeId","effective-agent"])("rejects optional identity contradiction %s",key=>{
  const f=fixture();
  if(key==="id"||key==="role")(f.s.result.projection as any)[key]="other";
  else (f.s.result.worker as any).startOptions=key==="resolvedWorktreeId"?{resolvedWorktreeId:"other"}:{launch:{effective:{agent:"other"}}};
  expect(()=>run(f)).toThrow();
});
