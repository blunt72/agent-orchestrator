import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
const gates=vi.hoisted(()=>({task:null as any,readiness:vi.fn(),complete:vi.fn()}));
vi.mock("../../src/integrations/orca-read-only-store.js",()=>({OrcaReadOnlyStore:class{async getTask(){return structuredClone(gates.task);}}}));
vi.mock("../../src/integrations/orca-limited-readiness.js",()=>({inspectOrcaLimitedReadiness:gates.readiness}));
vi.mock("../../src/integrations/orca-task-completion.js",()=>({completeOrcaTaskLimited:gates.complete,fingerprintOrcaTaskCompletionImplementation:()=>"c".repeat(64)}));
import {runLimitedWorkflow,type LimitedWorkflowOptions} from "../../src/cli/limited-workflow.js";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
let root:string,options:LimitedWorkflowOptions;
beforeEach(async()=>{
 vi.clearAllMocks();root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"limited-cli-unit-")));
 const bundle=path.join(root,"bundle.json"),policy=path.join(root,"policy.json");await fs.writeFile(bundle,"{}");await fs.writeFile(policy,"{}");
 options={storeRoot:root,sessionsRoot:root,taskId:"task",bundle,bundleSha256:sha("{}"),policy,policySha256:sha("{}")};
 gates.task={id:"task",projectId:"project-a",revision:19,status:"REVIEW",orcaBinding:{agenthubTaskId:"task",projectId:"project-a",revision:"4",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",dispatchId:"dispatch",workspaceId:"workspace",workspacePath:root,terminalHandle:"terminal",developer:"gemini",reviewer:"codex",provider:"antigravity",ownerId:"gemini",claimId:null}};
 gates.readiness.mockResolvedValue({retainedEvidenceConsistent:true,enrollmentDigest:"e".repeat(64),allowedFiles:["test.ts"],changedFiles:[".DS_Store","test.ts"],canCompleteTask:false});
 gates.complete.mockResolvedValue({status:"DONE",outboxState:"PENDING"});
});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
it("preflight is read-only and never invokes completion",async()=>{
 const before=await fs.readdir(root);expect(await runLimitedWorkflow("preflight",options)).toMatchObject({currentStatus:"REVIEW",canCompleteTask:false,historicalSnapshot:false});
 expect(await fs.readdir(root)).toEqual(before);expect(gates.complete).not.toHaveBeenCalled();
});
it.each(["project-a","project-b"])("generates a NOT_APPROVED request for %s without issuing approval",async project=>{
 gates.task.projectId=project;gates.task.orcaBinding.projectId=project;
 const output=path.join(root,"request.json");
 const result=await runLimitedWorkflow("request",{...options,output});
 const raw=await fs.readFile(output,"utf8"),request=JSON.parse(raw);
 expect(request.status).toBe("NOT_APPROVED");expect(request.subjects.projectId).toBe(project);
 expect(request.approvalIssued).toBe(false);expect(request.canCompleteTask).toBe(false);
 expect(result).toMatchObject({requestSha256:sha(raw)});
 expect(gates.complete).not.toHaveBeenCalled();
 await expect(runLimitedWorkflow("request",{...options,output})).rejects.toThrow();
});
it("historical preflight is labeled and cannot create a new request",async()=>{
 const original=structuredClone(gates.task);gates.task.status="DONE";gates.task.revision=21;gates.task.orcaTaskCompletion={originalTask:original};
 expect(await runLimitedWorkflow("preflight",options)).toMatchObject({currentStatus:"DONE",historicalSnapshot:true,canCompleteTask:false});
 expect(gates.readiness.mock.calls[0][7]).toEqual(original);
 await expect(runLimitedWorkflow("request",{...options,output:path.join(root,"request.json")})).rejects.toThrow();
});
it.each(["complete","reconcile"] as const)("forwards exactly one explicit %s action with both pins",async action=>{
 await runLimitedWorkflow(action,{...options,approvalSha256:"a".repeat(64),implementationSha256:"b".repeat(64)});
 expect(gates.complete).toHaveBeenCalledTimes(1);expect(gates.complete.mock.calls[0][0]).toMatchObject({taskId:"task",action,expectedApprovalDigest:"a".repeat(64),expectedImplementationDigest:"b".repeat(64)});
});
it.each(["missing-pin","bad-digest","symlink","oversize","extra-option"])("rejects %s before mutation",async kind=>{
 let changed:any={...options,approvalSha256:"a".repeat(64),implementationSha256:"b".repeat(64)};
 if(kind==="missing-pin")delete changed.approvalSha256;
 if(kind==="bad-digest")changed.bundleSha256="0".repeat(64);
 if(kind==="symlink"){const link=path.join(root,"link");await fs.symlink(options.bundle,link);changed.bundle=link;}
 if(kind==="oversize")await fs.writeFile(options.bundle," ".repeat(32769));
 if(kind==="extra-option")changed.approve=true;
 await expect(runLimitedWorkflow("complete",changed)).rejects.toThrow();expect(gates.complete).not.toHaveBeenCalled();
});
it("detects input drift while awaiting readiness and emits no request",async()=>{
 gates.readiness.mockImplementation(async()=>{await fs.writeFile(options.bundle,'{"changed":true}');return {retainedEvidenceConsistent:true};});
 const output=path.join(root,"request.json");await expect(runLimitedWorkflow("request",{...options,output})).rejects.toThrow();
 await expect(fs.stat(output)).rejects.toThrow();
});
