import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
import { registerOrcaTaskEnrollment } from "../../src/integrations/orca-task-enrollment-registration.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { TaskRevisionStore } from "../../src/integrations/task-revision-store.js";
let root:string,sessions:string,target:string,record:any;
const b={agenthubTaskId:"task",projectId:"project",revision:"4",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",
  dispatchId:"dispatch",workspaceId:"workspace",workspacePath:"/workspace",terminalHandle:"terminal",developer:"codex",reviewer:"gemini",provider:"codex",ownerId:"codex",claimId:null};
const hash=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
const options=()=>{const bytes=Buffer.from(JSON.stringify(record));return {projectRoot:root,sessionsRoot:sessions,taskId:"task",expectedRevision:1,record:bytes,recordSha256:hash(bytes),action:"install" as const};};
beforeEach(async()=>{
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"enrollment-register-")));sessions=path.join(root,"sessions");fs.mkdirSync(sessions);
  fs.mkdirSync(path.join(root,"data/orca-trust-v1"),{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,"data/orca-evidence-v1"));
  target=path.join(root,"data/orca-trust-v1/task.enrollment.json");
  await new TaskRevisionStore(root).save({id:"task",revision:0,status:"REVIEW",projectId:"project",orcaGeneration:1,orcaBinding:b},null);
  record={version:1,purpose:"LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT",registeredAt:"2026-10-15T00:00:00.000Z",
    operator:{namespace:"agenthub-local-operator-v1",subject:"aaaaaaaa-0000-4000-8000-000000000005"},
    scope:{taskId:"task",projectId:"project",generation:1,bindingDigest:parseOrcaCompletionBinding(JSON.stringify(b)).digest},
    evidenceRoots:[sessions,path.join(root,"data/orca-evidence-v1")],authorizationBasis:"synthetic registration only",sourceAuthenticated:false,canCompleteTask:false};
});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
it("installs an exact private task record without mutating task/global record",async()=>{
  const task=fs.readFileSync(path.join(root,"data/tasks/task.json")),global=path.join(root,"data/orca-trust-v1/enrollment.json");
  fs.writeFileSync(global,"historical",{mode:0o600});
  const o=options(),r=await registerOrcaTaskEnrollment(o);
  expect(r).toMatchObject({installed:true,replay:false,taskMutated:false,canCompleteTask:false,sourceAuthenticated:false});
  expect(fs.readFileSync(target)).toEqual(o.record);expect(fs.statSync(target).mode&0o777).toBe(0o600);expect(fs.statSync(target).nlink).toBe(1);
  expect(fs.readFileSync(path.join(root,"data/tasks/task.json"))).toEqual(task);expect(fs.readFileSync(global,"utf8")).toBe("historical");
  await expect(registerOrcaTaskEnrollment(o)).rejects.toThrow("TASK_ENROLLMENT_ALREADY_EXISTS");
  expect((await registerOrcaTaskEnrollment({...o,action:"reconcile"})).replay).toBe(true);
});
it.each(["scope","capability","operator","roots","extra","digest","revision"])("rejects invalid %s before publication",async kind=>{
  if(kind==="scope")record.scope.bindingDigest="b".repeat(64);
  if(kind==="capability")record.canCompleteTask=true;
  if(kind==="operator")record.operator.namespace="google";
  if(kind==="roots")record.evidenceRoots.reverse();
  if(kind==="extra")record.extra=true;
  const o=options();if(kind==="digest")o.recordSha256="b".repeat(64);if(kind==="revision")o.expectedRevision=2;
  await expect(registerOrcaTaskEnrollment(o)).rejects.toThrow();expect(fs.existsSync(target)).toBe(false);
});
it("does not reconcile absent or different records",async()=>{
  await expect(registerOrcaTaskEnrollment({...options(),action:"reconcile"})).rejects.toThrow("TASK_ENROLLMENT_NOT_INSTALLED");
  await registerOrcaTaskEnrollment(options());record.authorizationBasis="different";
  await expect(registerOrcaTaskEnrollment({...options(),action:"reconcile"})).rejects.toThrow("TASK_ENROLLMENT_REPLAY_CONFLICT");
});
it("rejects public trust directory and symlinked target",async()=>{
  const dir=path.dirname(target);fs.chmodSync(dir,0o755);await expect(registerOrcaTaskEnrollment(options())).rejects.toThrow();
  fs.chmodSync(dir,0o700);const other=path.join(root,"other");fs.writeFileSync(other,options().record,{mode:0o600});fs.symlinkSync(other,target);
  await expect(registerOrcaTaskEnrollment({...options(),action:"reconcile"})).rejects.toThrow();expect(fs.readFileSync(other)).toEqual(options().record);
});
it("rejects cancellation before publication",async()=>{
  const read=TaskRevisionStore.prototype.read;let calls=0;
  vi.spyOn(TaskRevisionStore.prototype,"read").mockImplementation(async function(this:TaskRevisionStore,id){
    if(++calls===2){const file=path.join(root,"data/tasks/task.json"),t=JSON.parse(fs.readFileSync(file,"utf8"));t.status="CANCELLED";t.revision++;fs.writeFileSync(file,JSON.stringify(t));}
    return read.call(this,id);
  });
  await expect(registerOrcaTaskEnrollment(options())).rejects.toThrow("TASK_ENROLLMENT_SNAPSHOT_CHANGED");expect(fs.existsSync(target)).toBe(false);
});
it("reconciles a published record after an uncertain reply without replacing it",async()=>{
  const link=fs.linkSync;
  vi.spyOn(fs,"linkSync").mockImplementationOnce((from,to)=>{link(from,to);throw Error("PUBLICATION_REPLY_LOST");});
  const o=options();await expect(registerOrcaTaskEnrollment(o)).rejects.toThrow("PUBLICATION_REPLY_LOST");
  const inode=fs.statSync(target).ino;
  expect((await registerOrcaTaskEnrollment({...o,action:"reconcile"})).replay).toBe(true);expect(fs.statSync(target).ino).toBe(inode);
});
it("repairs only the exact temporary hardlink after failed publication cleanup",async()=>{
  const unlink=fs.unlinkSync,o=options();
  vi.spyOn(fs,"unlinkSync").mockImplementationOnce(file=>{if(String(file).endsWith(".enrollment.tmp"))throw Error("TEMP_UNLINK_FAILED");unlink(file);});
  await expect(registerOrcaTaskEnrollment(o)).rejects.toThrow("TEMP_UNLINK_FAILED");
  expect(fs.statSync(target).nlink).toBe(2);const inode=fs.statSync(target).ino;
  expect((await registerOrcaTaskEnrollment({...o,action:"reconcile"})).replay).toBe(true);
  expect(fs.statSync(target).nlink).toBe(1);expect(fs.statSync(target).ino).toBe(inode);
});
it("does not repair unrelated hardlinks",async()=>{
  const o=options();await registerOrcaTaskEnrollment(o);const other=path.join(root,"unrelated");fs.linkSync(target,other);
  await expect(registerOrcaTaskEnrollment({...o,action:"reconcile"})).rejects.toThrow();expect(fs.statSync(target).nlink).toBe(2);expect(fs.existsSync(other)).toBe(true);
});
