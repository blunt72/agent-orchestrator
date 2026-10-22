import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({ready:vi.fn(),workspace:vi.fn()}));
vi.mock("../../src/integrations/orca-print-completion-runtime.js",()=>({inspectOrcaPrintCompletionRuntime:()=>({digest:"d".repeat(64),root:"/synthetic-runtime"})}));
vi.mock("../../src/integrations/orca-print-limited-readiness.js",()=>({inspectOrcaPrintLimitedReadiness:mocks.ready}));
vi.mock("../../src/integrations/orca-tests.js",()=>({fingerprintOrcaWorkspace:mocks.workspace}));
import { completeOrcaPrintTaskLimited,fingerprintOrcaPrintCompletionImplementation } from "../../src/integrations/orca-print-task-completion.js";
import { TaskRevisionStore } from "../../src/integrations/task-revision-store.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
const hash=(v:Buffer|string)=>createHash("sha256").update(v).digest("hex");
let root:string,sessions:string,taskFile:string,approvalFile:string,approval:any,subjects:any,original:any,options:any;
const b={agenthubTaskId:"task",projectId:"project",revision:"1",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",
  dispatchId:"dispatch",workspaceId:"workspace",workspacePath:"/workspace",terminalHandle:"terminal",developer:"codex",reviewer:"gemini",provider:"codex",ownerId:"codex",claimId:null};
const operator={namespace:"agenthub-local-operator-v1",subject:"aaaaaaaa-0000-4000-8000-000000000005"};
function publishApproval(){const bytes=Buffer.from(JSON.stringify(approval));fs.writeFileSync(approvalFile,bytes,{mode:0o600});options.expectedApprovalDigest=hash(bytes);}
beforeEach(async()=>{
  vi.resetAllMocks();root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"print-complete-")));sessions=path.join(root,"sessions");fs.mkdirSync(sessions);
  fs.mkdirSync(path.join(root,"data/orca-trust-v1"),{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,"data/orca-evidence-v1"));
  await new TaskRevisionStore(root).save({id:"task",revision:0,status:"REVIEW",projectId:"project",orcaGeneration:1,orcaBinding:b,currentRound:1,testCommand:"node test.cjs"},null);
  taskFile=path.join(root,"data/tasks/task.json");original=JSON.parse(fs.readFileSync(taskFile,"utf8"));
  const bindingDigest=parseOrcaCompletionBinding(JSON.stringify(b)).digest;
  const enrollment=Buffer.from(JSON.stringify({version:1,purpose:"LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT",registeredAt:"2026-10-14T00:00:00.000Z",operator,
    scope:{taskId:"task",projectId:"project",generation:1,bindingDigest},evidenceRoots:[sessions,path.join(root,"data/orca-evidence-v1")],
    authorizationBasis:"synthetic test only",sourceAuthenticated:false,canCompleteTask:false}));
  fs.writeFileSync(path.join(root,"data/orca-trust-v1/task.enrollment.json"),enrollment,{mode:0o600});
  const settlement=Buffer.from("synthetic settlement"),release=Buffer.from("synthetic release");
  subjects={taskId:"task",revision:1,bindingDigest,enrollmentDigest:hash(enrollment),operator,originalTaskDigest:hash(JSON.stringify(original)),
    settlementSha256:hash(settlement),releaseSha256:hash(release),workerIncarnation:"11111111-1111-4111-8111-111111111111",
    finalizationHash:"a".repeat(64),workspaceHash:"b".repeat(64),changedFiles:["test.cjs"]};
  options={projectRoot:root,sessionsRoot:sessions,taskId:"task",expectedApprovalDigest:"",expectedImplementationDigest:fingerprintOrcaPrintCompletionImplementation(),action:"complete",settlement,release};
  approval={version:1,purpose:"TASK_SCOPED_PRINT_LIMITED_COMPLETION_APPROVAL",approvedAt:"2026-10-14T00:00:00.000Z",operator,
    subjects:{...subjects,attempt:"recovery",implementationDigest:options.expectedImplementationDigest,runtimeArtifactDigest:"d".repeat(64)},retainedGaps:["USER_OWNED_RETAINED_TERMINAL","SOURCE_NOT_AUTHENTICATED","HISTORICAL_LIFECYCLE_ONLY"],sourceAuthenticated:false};
  approvalFile=path.join(root,"data/orca-trust-v1/task.print-limited-v1-approval.json");publishApproval();
  mocks.ready.mockResolvedValue({subjects});mocks.workspace.mockResolvedValue(subjects.workspaceHash);
});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
it("commits once then explicitly reconciles one event, preserving original snapshot",async()=>{
  const r=await completeOrcaPrintTaskLimited(options);expect(r).toMatchObject({status:"DONE",revision:2,outboxState:"PENDING",globalGateApproved:false});
  const done=JSON.parse(fs.readFileSync(taskFile,"utf8"));expect(done.orcaPrintTaskCompletion.originalTask).toEqual(original);
  expect((await completeOrcaPrintTaskLimited(options)).replay).toBe(true);
  await expect(new TaskRevisionStore(root).save(done,2)).rejects.toThrow("BOUND_COMPLETION_DISABLED");
  mocks.ready.mockRejectedValue(Error("must not rerun readiness"));mocks.workspace.mockRejectedValue(Error("must not check historical workspace"));
  const reconcile={...options,action:"reconcile"};expect(await completeOrcaPrintTaskLimited(reconcile)).toMatchObject({revision:3,outboxState:"PROJECTED"});
  expect((await completeOrcaPrintTaskLimited(reconcile)).replay).toBe(true);
  expect(fs.readFileSync(path.join(root,"logs/tasks/task.jsonl"),"utf8").trim().split("\n")).toHaveLength(1);
});
it.each(["missing","public","symlink","gaps","authority","pin","implementation","subjects","receipt"])("rejects unapproved or inconsistent %s",async kind=>{
  const before=fs.readFileSync(taskFile);
  if(kind==="missing")fs.unlinkSync(approvalFile);
  if(kind==="public")fs.chmodSync(approvalFile,0o644);
  if(kind==="symlink"){fs.renameSync(approvalFile,approvalFile+".original");fs.symlinkSync(approvalFile+".original",approvalFile);}
  if(kind==="gaps"){approval.retainedGaps=[];publishApproval();}
  if(kind==="authority"){approval.sourceAuthenticated=true;publishApproval();}
  if(kind==="pin")options.expectedApprovalDigest="a".repeat(64);
  if(kind==="implementation")options.expectedImplementationDigest="a".repeat(64);
  if(kind==="subjects"){approval.subjects.workspaceHash="c".repeat(64);publishApproval();}
  if(kind==="receipt")options.release=Buffer.from("changed");
  await expect(completeOrcaPrintTaskLimited(options)).rejects.toThrow();expect(fs.readFileSync(taskFile)).toEqual(before);
});
it("rejects final task drift without overwriting cancellation",async()=>{
  mocks.ready.mockImplementation(async()=>{fs.writeFileSync(taskFile,JSON.stringify({...original,status:"CANCELLED",revision:2}));return {subjects};});
  await expect(completeOrcaPrintTaskLimited(options)).rejects.toThrow("PRINT_COMPLETION_FINAL_DRIFT");expect(JSON.parse(fs.readFileSync(taskFile,"utf8")).status).toBe("CANCELLED");
});
it("rejects approval drift during awaits",async()=>{
  mocks.ready.mockImplementation(async()=>{fs.writeFileSync(approvalFile,"changed");return {subjects};});
  await expect(completeOrcaPrintTaskLimited(options)).rejects.toThrow();expect(JSON.parse(fs.readFileSync(taskFile,"utf8")).status).toBe("REVIEW");
});
it("reconciles an uncertain commit reply without another transition",async()=>{
  const rename=fs.renameSync;vi.spyOn(fs,"renameSync").mockImplementationOnce((from,to)=>{rename(from,to);throw Error("COMMIT_REPLY_LOST");});
  await expect(completeOrcaPrintTaskLimited(options)).rejects.toThrow("COMMIT_REPLY_LOST");
  expect((await completeOrcaPrintTaskLimited(options)).revision).toBe(2);
});
it("reconciles event projection failure without duplicate events",async()=>{
  await completeOrcaPrintTaskLimited(options);const rename=fs.renameSync;
  vi.spyOn(fs,"renameSync").mockImplementationOnce(()=>{throw Error("PROJECTION_FAILED");});
  await expect(completeOrcaPrintTaskLimited({...options,action:"reconcile"})).rejects.toThrow("PROJECTION_FAILED");
  vi.mocked(fs.renameSync).mockImplementation(rename);
  expect((await completeOrcaPrintTaskLimited({...options,action:"reconcile"})).revision).toBe(3);
  expect(fs.readFileSync(path.join(root,"logs/tasks/task.jsonl"),"utf8").trim().split("\n")).toHaveLength(1);
});
it.each(["bytes","depth","nodes"])("rejects an unreadable completed payload at %s boundary before committing",async kind=>{
  if(kind==="bytes")original.description="x".repeat(140000);
  if(kind==="depth"){let nested:any=0;for(let i=0;i<23;i++)nested={child:nested};original.extraDeep=nested;}
  if(kind==="nodes")original.extraNodes=Array(11000).fill(0);
  fs.writeFileSync(taskFile,JSON.stringify(original));subjects.originalTaskDigest=hash(JSON.stringify(original));approval.subjects.originalTaskDigest=subjects.originalTaskDigest;publishApproval();
  const before=fs.readFileSync(taskFile);
  await expect(completeOrcaPrintTaskLimited(options)).rejects.toThrow("PRINT_COMPLETION_PAYLOAD_LIMIT");expect(fs.readFileSync(taskFile)).toEqual(before);
});
