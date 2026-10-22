import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { registerOrcaDevelopmentEnrollment } from "../../src/integrations/orca-development-enrollment.js";
import { registerOrcaTaskEnrollment } from "../../src/integrations/orca-task-enrollment-registration.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { TaskRevisionStore } from "../../src/integrations/task-revision-store.js";

let root:string, sessions:string, record:Record<string,unknown>;
const binding={agenthubTaskId:"new-task",projectId:"project",revision:"1",generation:1,
  runtimeId:"synthetic-runtime",hostId:"local",runId:"synthetic-run",taskId:"synthetic-task",
  dispatchId:"synthetic-dispatch",workspaceId:"workspace",workspacePath:"/synthetic-workspace",
  terminalHandle:"synthetic-terminal",developer:"codex",reviewer:"gemini",provider:"codex",ownerId:"codex",claimId:null};
const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const target=()=>path.join(root,"data/orca-trust-v1/new-task.enrollment.json");
const taskFile=()=>path.join(root,"data/tasks/new-task.json");
const options=()=>{
  const bytes=Buffer.from(JSON.stringify(record));
  return {projectRoot:root,sessionsRoot:sessions,taskId:"new-task",expectedRevision:1,
    record:bytes,recordSha256:hash(bytes),action:"install" as const};
};
function changeTask(update:Record<string,unknown>){
  const task=JSON.parse(fs.readFileSync(taskFile(),"utf8"));
  Object.assign(task,update);fs.writeFileSync(taskFile(),JSON.stringify(task));
}
beforeEach(async()=>{
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"development-enrollment-")));
  sessions=path.join(root,"sessions");fs.mkdirSync(sessions);
  fs.mkdirSync(path.join(root,"data/orca-trust-v1"),{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(root,"data/orca-evidence-v1"));
  await new TaskRevisionStore(root).save({id:"new-task",revision:0,status:"DOING",projectId:"project",
    ownerType:"AGENT",owner:"codex",ownerId:"codex",reviewer:"gemini",workspace:"/synthetic-workspace",
    orcaGeneration:1,orcaBinding:binding,orcaBaseline:{version:1,evidence:{version:1,sha256:"a".repeat(64),bytes:1},workspaceHash:"b".repeat(64)}},null);
  record={version:1,purpose:"LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT",registeredAt:"2026-10-15T00:00:00.000Z",
    operator:{namespace:"agenthub-local-operator-v1",subject:"aaaaaaaa-0000-4000-8000-000000000005"},
    scope:{taskId:"new-task",projectId:"project",generation:1,bindingDigest:parseOrcaCompletionBinding(JSON.stringify(binding)).digest},
    evidenceRoots:[sessions,path.join(root,"data/orca-evidence-v1")],authorizationBasis:"synthetic registration, not authorization",
    sourceAuthenticated:false,canCompleteTask:false};
});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});

it("publishes DOING enrollment without changing old task, global enrollment or active permissions",async()=>{
  const old=path.join(root,"data/tasks/old-task.json"),global=path.join(root,"data/orca-trust-v1/enrollment.json");
  fs.writeFileSync(old,"historical old binding");fs.writeFileSync(global,"historical",{mode:0o600});
  const before=fs.readFileSync(taskFile());
  const result=await registerOrcaDevelopmentEnrollment(options());
  expect(result).toMatchObject({phase:"DOING",installed:true,taskMutated:false,
    canReply:false,permissionIssued:false,canCompleteTask:false,sourceAuthenticated:false});
  expect(fs.readFileSync(taskFile())).toEqual(before);
  expect(fs.readFileSync(old,"utf8")).toBe("historical old binding");
  expect(fs.readFileSync(global,"utf8")).toBe("historical");
  expect(fs.existsSync(path.join(root,"data/orca-execution-v1"))).toBe(false);
  expect(fs.statSync(target()).mode&0o777).toBe(0o600);
  await expect(registerOrcaDevelopmentEnrollment(options())).rejects.toThrow("TASK_ENROLLMENT_ALREADY_EXISTS");
  expect((await registerOrcaDevelopmentEnrollment({...options(),action:"reconcile"})).replay).toBe(true);
});
it.each([
  {status:"REVIEW"},{status:"DONE"},{status:"CANCELLED"},{orcaBaseline:undefined},
  {orcaBinding:undefined},{pendingAgentTurn:{}},{pendingHumanResponse:"hold"},{result:{}},
  {orcaCompletion:{}},{orcaTaskCompletion:{}},{orcaPrintTaskCompletion:{}},{revision:2},
  {owner:"gemini"},{ownerId:"other"},{ownerType:"HUMAN"},{reviewer:"codex"},{workspace:"/other"},
  {claim:{id:"different",ownerId:"codex"}}
])("rejects incompatible development task %j without publishing",async update=>{
  changeTask(update);await expect(registerOrcaDevelopmentEnrollment(options())).rejects.toThrow();
  expect(fs.existsSync(target())).toBe(false);
});
it("retains REVIEW-only legacy registration and permits later identical review reconciliation",async()=>{
  await expect(registerOrcaTaskEnrollment(options())).rejects.toThrow("TASK_ENROLLMENT_NOT_READY");
  await registerOrcaDevelopmentEnrollment(options());const inode=fs.statSync(target()).ino;
  changeTask({status:"REVIEW"});
  await expect(registerOrcaDevelopmentEnrollment({...options(),action:"reconcile"})).rejects.toThrow();
  expect((await registerOrcaTaskEnrollment({...options(),action:"reconcile"})).replay).toBe(true);
  expect(fs.statSync(target()).ino).toBe(inode);
});
it("rejects changed task snapshot before publication",async()=>{
  const read=TaskRevisionStore.prototype.read;let calls=0;
  vi.spyOn(TaskRevisionStore.prototype,"read").mockImplementation(async function(this:TaskRevisionStore,id){
    if(++calls===2)changeTask({status:"CANCELLED",revision:2});
    return read.call(this,id);
  });
  await expect(registerOrcaDevelopmentEnrollment(options())).rejects.toThrow("TASK_ENROLLMENT_SNAPSHOT_CHANGED");
  expect(fs.existsSync(target())).toBe(false);
});
it.each([Buffer.alloc(0),Buffer.alloc(16385),"not bytes"])("rejects invalid raw input before copying or publication",async bytes=>{
  await expect(registerOrcaDevelopmentEnrollment({...options(),record:bytes as Buffer})).rejects.toThrow("INVALID_TASK_ENROLLMENT_REGISTRATION");
  expect(fs.existsSync(target())).toBe(false);
});
