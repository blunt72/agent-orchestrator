import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
const gate=vi.hoisted(()=>({readiness:vi.fn(),fingerprint:vi.fn()}));
vi.mock("../../src/integrations/orca-limited-readiness.js",()=>({inspectOrcaLimitedReadiness:gate.readiness}));
vi.mock("../../src/integrations/orca-tests.js",()=>({fingerprintOrcaWorkspace:gate.fingerprint}));
vi.mock("../../src/integrations/orca-local-enrollment.js",()=>({readOrcaTaskEnrollment:()=>({digest:"e".repeat(64),operator:{namespace:"agenthub-local-operator-v1",subject:"11111111-1111-4111-8111-111111111111"}})}));
import {completeOrcaTaskLimited,fingerprintOrcaTaskCompletionImplementation,type TaskCompletionOptions} from "../../src/integrations/orca-task-completion.js";
import {parseOrcaCompletionBinding} from "../../src/integrations/orca-evidence-manifest.js";
import {TaskRevisionStore} from "../../src/integrations/task-revision-store.js";
import * as events from "../../src/integrations/task-event-store.js";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
let root:string,task:any,approval:any,options:TaskCompletionOptions,filename:string;
const read=async()=>JSON.parse(await fs.readFile(path.join(root,"data/tasks/task.json"),"utf8"));
async function issue(){const raw=JSON.stringify(approval);await fs.writeFile(filename,raw,{mode:0o600});options.expectedApprovalDigest=sha(raw);}
beforeEach(async()=>{
 vi.clearAllMocks();root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"task-completion-unit-")));
 await fs.mkdir(path.join(root,"sessions"));await fs.mkdir(path.join(root,"data/tasks"),{recursive:true});
 await fs.mkdir(path.join(root,"data/orca-trust-v1"),{mode:0o700});
 const binding={agenthubTaskId:"task",projectId:"project",revision:"4",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",dispatchId:"dispatch",workspaceId:"workspace",workspacePath:root,terminalHandle:"terminal",developer:"gemini",reviewer:"codex",provider:"antigravity",ownerId:"gemini",claimId:null};
 task={id:"task",projectId:"project",revision:19,status:"REVIEW",orcaBinding:binding,orcaGeneration:1,currentRound:0,testCommand:"focused"};
 await fs.writeFile(path.join(root,"data/tasks/task.json"),JSON.stringify(task));
 options={projectRoot:root,sessionsRoot:path.join(root,"sessions"),taskId:"task",rawBundle:"{}",rawPolicy:"{}",expectedApprovalDigest:"a".repeat(64),expectedImplementationDigest:fingerprintOrcaTaskCompletionImplementation(),action:"complete"};
 approval={version:1,purpose:"TASK_SCOPED_HUMAN_LIMITED_COMPLETION_APPROVAL",approvedAt:"2026-10-14T00:00:00.000Z",operator:{namespace:"agenthub-local-operator-v1",subject:"11111111-1111-4111-8111-111111111111"},sourceAuthenticated:false,retainedGaps:["METADATA_EXCEPTION","USER_OWNED_RETAINED_TERMINAL","SOURCE_NOT_AUTHENTICATED"],subjects:{taskId:"task",projectId:"project",expectedRevision:19,bindingDigest:parseOrcaCompletionBinding(JSON.stringify(binding)).digest,originalTaskDigest:sha(JSON.stringify(task)),bundleDigest:sha("{}"),policyDigest:sha("{}"),enrollmentDigest:"e".repeat(64),implementationDigest:options.expectedImplementationDigest,allowedFiles:["test.ts","untouched.ts"],changedFiles:[".DS_Store","test.ts"]}};
 filename=path.join(root,"data/orca-trust-v1/task.limited-v2-approval.json");await issue();
 gate.readiness.mockResolvedValue({retainedEvidenceConsistent:true,enrollmentDigest:"e".repeat(64),allowedFiles:["test.ts","untouched.ts"],changedFiles:[".DS_Store","test.ts"],acceptance:{workspaceHash:"f".repeat(64)}});
 gate.fingerprint.mockResolvedValue("f".repeat(64));
});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
it("commits a snapshot/outbox, then explicitly reconciles exactly once (synthetic admission)",async()=>{
 expect(await completeOrcaTaskLimited(options)).toMatchObject({status:"DONE",revision:20,outboxState:"PENDING"});
 const pending=await read();expect(pending.orcaTaskCompletion.originalTask).toEqual(task);
 expect(pending.result.changedFiles).toEqual([".DS_Store","test.ts"]);
 expect(pending.result.changedFiles).not.toContain("untouched.ts");
 expect(await completeOrcaTaskLimited(options)).toMatchObject({outboxState:"PENDING",replay:true});
 expect(await completeOrcaTaskLimited({...options,action:"reconcile"})).toMatchObject({revision:21,outboxState:"PROJECTED"});
 const projected=await read();const log=await fs.readFile(path.join(root,"logs/tasks/task.jsonl"),"utf8");
 expect(JSON.parse(log.trim())).toEqual(projected.orcaTaskCompletion.outbox.event);
 expect(await completeOrcaTaskLimited(options)).toMatchObject({outboxState:"PROJECTED",replay:true});
 expect(await fs.readFile(path.join(root,"logs/tasks/task.jsonl"),"utf8")).toBe(log);
});
it.each(["pin","subject","permissions","missing","runtime","gate"])("rejects %s without task mutation",async kind=>{
 if(kind==="pin")options.expectedApprovalDigest="0".repeat(64);
 if(kind==="subject"){approval.subjects.expectedRevision++;await issue();}
 if(kind==="permissions")await fs.chmod(filename,0o644);
 if(kind==="missing")await fs.unlink(filename);
 if(kind==="runtime")options.expectedImplementationDigest="0".repeat(64);
 if(kind==="gate")gate.readiness.mockRejectedValue(Error("admission failed"));
 await expect(completeOrcaTaskLimited(options)).rejects.toThrow();expect(await read()).toEqual(task);
});
it("rejects final task drift before rename",async()=>{
 gate.readiness.mockImplementation(async()=>{await fs.writeFile(path.join(root,"data/tasks/task.json"),JSON.stringify({...task,revision:20}));return {retainedEvidenceConsistent:true,enrollmentDigest:"e".repeat(64),allowedFiles:["test.ts","untouched.ts"],changedFiles:[".DS_Store","test.ts"],acceptance:{workspaceHash:"f".repeat(64)}};});
 await expect(completeOrcaTaskLimited(options)).rejects.toThrow("TASK_COMPLETION_FINAL_DRIFT");
 expect((await read()).status).toBe("REVIEW");
});
it("prevents ordinary writes to a task carrying the new completion record",async()=>{
 await completeOrcaTaskLimited(options);const after=await read();
 await expect(new TaskRevisionStore(root).save(after,after.revision)).rejects.toThrow("BOUND_COMPLETION_DISABLED");
});
it("keeps the pending receipt after event failure and recovers explicitly",async()=>{
 await completeOrcaTaskLimited(options);const pending=await read();
 const spy=vi.spyOn(events,"writeTaskEvent").mockRejectedValueOnce(Error("synthetic event I/O failure"));
 await expect(completeOrcaTaskLimited({...options,action:"reconcile"})).rejects.toThrow("synthetic event I/O failure");
 expect(await read()).toEqual(pending);spy.mockRestore();
 expect(await completeOrcaTaskLimited({...options,action:"reconcile"})).toMatchObject({outboxState:"PROJECTED"});
});
it("reconciles and replays the committed event after workspace drift/removal",async()=>{
 await completeOrcaTaskLimited(options);
 gate.readiness.mockRejectedValue(Error("historical workspace removed"));
 gate.fingerprint.mockRejectedValue(Error("historical workspace removed"));
 expect(await completeOrcaTaskLimited({...options,action:"reconcile"})).toMatchObject({outboxState:"PROJECTED"});
 expect(await completeOrcaTaskLimited(options)).toMatchObject({outboxState:"PROJECTED",replay:true});
 expect(gate.readiness).toHaveBeenCalledTimes(1);expect(gate.fingerprint).toHaveBeenCalledTimes(1);
});
it.each(["future","gaps","operator","extra"])("rejects invalid approval %s",async kind=>{
 if(kind==="future")approval.approvedAt="2099-01-01T00:00:00.000Z";
 if(kind==="gaps")approval.retainedGaps=[];
 if(kind==="operator")approval.operator.subject="22222222-2222-4222-8222-222222222222";
 if(kind==="extra")approval.canCompleteTask=true;
 await issue();await expect(completeOrcaTaskLimited(options)).rejects.toThrow("INVALID_TASK_APPROVAL");expect(await read()).toEqual(task);
});
