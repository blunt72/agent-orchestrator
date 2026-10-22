import fs from "node:fs";
import path from "node:path";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
vi.mock("../../src/integrations/orca-permission-preflight.js",()=>({inspectOrcaPermissionPreflight:vi.fn(async()=>({localPreflightPassed:true}))}));
vi.mock("../../src/integrations/orca-print-completion-readiness.js",()=>({readOrcaPrintTaskSnapshot:vi.fn(()=>({id:"new-task",orcaBaseline:{synthetic:true}}))}));
import { inspectOrcaPermissionPreflight } from "../../src/integrations/orca-permission-preflight.js";
import { readOrcaPrintTaskSnapshot } from "../../src/integrations/orca-print-completion-readiness.js";
import { ExecutionReleaseController } from "../../src/integrations/orca-execution-release.js";
import { releaseHash } from "../../src/integrations/orca-execution-release-schema.js";
import { releaseFixture } from "./execution-release-fixture.js";

let f:ReturnType<typeof releaseFixture>;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(readOrcaPrintTaskSnapshot).mockImplementation(()=>({id:"new-task",orcaBaseline:{synthetic:true}} as any));f=releaseFixture();});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(f.root,{recursive:true,force:true});});
const install=()=>f.controller.install(f.material,f.approval());

it("installs private local registry with synthetic trusted adapters, not provider approval",async()=>{
  const old=path.join(f.root,"data/old-task.json");fs.writeFileSync(old,"historical");
  const result=await install();
  expect(result).toMatchObject({record:{state:"INSTALLED",intentId:null},humanApprovalVerifiedByAdapter:true,
    canReply:false,canCompleteTask:false,sourceAuthenticated:false});
  expect(f.verifyHumanApproval).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(old,"utf8")).toBe("historical");
  const dir=path.join(f.root,"data/orca-execution-v1");
  expect(fs.statSync(dir).mode&0o777).toBe(0o700);
  for(const file of fs.readdirSync(dir))expect(fs.statSync(path.join(dir,file)).mode&0o777).toBe(0o600);
  await expect(install()).rejects.toThrow("EXECUTION_RELEASE_ALREADY_EXISTS");
});
it("cannot install from matching approval JSON without a trusted authority callback",async()=>{
  const c=new ExecutionReleaseController(f.root,"/synthetic-sessions");
  await expect(c.install(f.material,f.approval())).rejects.toThrow("HUMAN_APPROVAL_CAPABILITY_UNAVAILABLE");
  expect(fs.existsSync(path.join(f.root,"data/orca-execution-v1"))).toBe(false);
});
it.each(["reject","wrong-request","wrong-approval","extra"])("rejects invalid authority attestation %s",async kind=>{
  f.verifyHumanApproval.mockImplementationOnce(async input=>({requestSha256:kind==="wrong-request"?"b".repeat(64):input.requestSha256,
    approvalSha256:kind==="wrong-approval"?"b".repeat(64):input.approvalSha256,humanApprovalVerified:kind!=="reject",
    evidenceId:"synthetic",...(kind==="extra"?{extra:true}:{})}));
  await expect(install()).rejects.toThrow("HUMAN_APPROVAL_NOT_VERIFIED");
});
it.each(["purpose","digest","operator","future","extra"])("rejects malformed approval %s",async kind=>{
  const a=JSON.parse(f.approval().toString());
  if(kind==="purpose")a.purpose="TASK_SCOPED_PRINT_MANAGED_COMPLETION_APPROVAL";
  if(kind==="digest")a.requestSha256="b".repeat(64);
  if(kind==="operator")a.operator.subject="other";
  if(kind==="future")a.approvedAt=new Date(f.clock.wallMs+1).toISOString();
  if(kind==="extra")a.extra=true;
  await expect(f.controller.install(f.material,Buffer.from(JSON.stringify(a)))).rejects.toThrow("INVALID_RELEASE_APPROVAL");
  expect(f.verifyHumanApproval).not.toHaveBeenCalled();
});
it.each([Buffer.alloc(0),Buffer.alloc(32769),Buffer.from([0xff]),Buffer.from('{"version":1,"version":1}')])("rejects invalid request bytes",async request=>{
  await expect(f.controller.install({...f.material,request},f.approval())).rejects.toThrow();
});
it.each(["oversized-window","zero-window","approved","scope"])("rejects request %s",async kind=>{
  const r={...f.request};
  if(kind==="oversized-window")r.expiresAt=new Date(Date.parse(r.issuedAt)+900001).toISOString();
  if(kind==="zero-window")r.expiresAt=r.issuedAt;
  if(kind==="approved")r.decision="APPROVED";
  if(kind==="scope")r.permissionSha256="b".repeat(64);
  f.material.request=Buffer.from(JSON.stringify(r));await expect(install()).rejects.toThrow();
});
it.each(["taskId","projectId","generation","bindingDigest","runtimeId","runId","orcaTaskId","dispatchId",
  "terminalHandle","workerIncarnation","resourceId","taskRevision","questionId","policySha256","workspaceHash"])(
  "rejects altered permission subject %s even after content hashes are recomputed",async key=>{
    const p=JSON.parse(f.material.permission.toString());
    p.subjects[key]=typeof p.subjects[key]==="number"?p.subjects[key]+1:"changed";
    f.material.permission=Buffer.from(JSON.stringify(p));
    f.material.expected.permissionSha256=releaseHash(f.material.permission);
    f.material.request=Buffer.from(JSON.stringify({...f.request,permissionSha256:f.material.expected.permissionSha256}));
    await expect(install()).rejects.toThrow();expect(f.verifyHumanApproval).not.toHaveBeenCalled();
  });
it("snapshots caller-owned request, permission and expectations before awaiting approval",async()=>{
  const original=releaseHash(f.material.request),approval=f.approval();
  f.verifyHumanApproval.mockImplementationOnce(async input=>{
    f.material.request.fill(0);f.material.permission.fill(0);f.material.expected.operator.subject="changed";
    return {requestSha256:input.requestSha256,approvalSha256:input.approvalSha256,humanApprovalVerified:true,evidenceId:"synthetic"};
  });
  const result=await f.controller.install(f.material,approval);
  expect(result.record.requestSha256).toBe(original);
});
it.each(["ownership","retained","incarnation","question","inactive"])("rejects live observation mismatch %s",async kind=>{
  f.observe.mockImplementationOnce(async identity=>({...identity,ownership:kind==="ownership"?"user_owned":"managed",
    retained:kind==="retained",workerIncarnation:kind==="incarnation"?"other":identity.workerIncarnation,
    questionPending:kind!=="question",dispatchActive:kind!=="inactive"}));
  await expect(install()).rejects.toThrow("RELEASE_OBSERVATION_REJECTED");
});
it("refuses stale observation after asynchronous context checking",async()=>{
  vi.mocked(inspectOrcaPermissionPreflight).mockImplementationOnce(async()=>{f.clock.monotonicMs+=2001;return {} as any;});
  await expect(install()).rejects.toThrow("RELEASE_OBSERVATION_STALE");
});
it("fails context validation before publishing an active grant",async()=>{
  vi.mocked(inspectOrcaPermissionPreflight).mockRejectedValueOnce(Error("CONTEXT_CHANGED"));
  await expect(install()).rejects.toThrow("CONTEXT_CHANGED");
  expect(fs.existsSync(path.join(f.root,"data/orca-execution-v1"))).toBe(false);
});
it.each([{orcaBaseline:undefined},{pendingAgentTurn:{}},{pendingHumanResponse:"hold"}])("rejects task readiness gap %j",async patch=>{
  vi.mocked(readOrcaPrintTaskSnapshot).mockReturnValue({id:"new-task",orcaBaseline:{synthetic:true},...patch} as any);
  await expect(install()).rejects.toThrow("EXECUTION_RELEASE_TASK_NOT_READY");
});
it("rejects task snapshot drift after preflight await",async()=>{
  vi.mocked(inspectOrcaPermissionPreflight).mockImplementationOnce(async()=>{
    vi.mocked(readOrcaPrintTaskSnapshot).mockReturnValue({id:"new-task",orcaBaseline:{synthetic:true},revision:5} as any);
    return {} as any;
  });
  await expect(install()).rejects.toThrow("EXECUTION_RELEASE_CONTEXT_CHANGED");
});
it("records revocation with CAS and never claims external undelivery",async()=>{
  const result=await install();
  const revoked=await f.controller.revoke("new-task",result.pin);
  expect(revoked).toMatchObject({record:{state:"REVOKED"},late:false,undeliveryVerified:false});
  await expect(f.controller.revoke("new-task",result.pin)).rejects.toThrow("EXECUTION_RELEASE_CONFLICT");
});
it.each(["symlink","hardlink","public"])("rejects unsafe registry files: %s",async kind=>{
  await install();const file=path.join(f.root,"data/orca-execution-v1/new-task.release.json");
  if(kind==="symlink"){const other=path.join(f.root,"other");fs.renameSync(file,other);fs.symlinkSync(other,file);}
  if(kind==="hardlink")fs.linkSync(file,path.join(f.root,"other"));
  if(kind==="public")fs.chmodSync(file,0o644);
  expect(()=>f.controller.store.read("new-task")).toThrow();
});
it("rejects public registry directory",async()=>{
  await install();fs.chmodSync(path.join(f.root,"data/orca-execution-v1"),0o755);
  expect(()=>f.controller.store.read("new-task")).toThrow("UNSAFE_EXECUTION_RELEASE_ROOT");
});
it("rejects root-directory replacement across an asynchronous approval check",async()=>{
  f.verifyHumanApproval.mockImplementationOnce(async input=>{
    fs.renameSync(path.join(f.root,"data"),path.join(f.root,"old-data"));fs.mkdirSync(path.join(f.root,"data"));
    return {requestSha256:input.requestSha256,approvalSha256:input.approvalSha256,humanApprovalVerified:true,evidenceId:"synthetic"};
  });
  await expect(install()).rejects.toThrow("EXECUTION_RELEASE_ROOT_CHANGED");
  expect(fs.existsSync(path.join(f.root,"data/orca-execution-v1"))).toBe(false);
});
it("rejects read-time file replacement and closes its descriptor",async()=>{
  await install();const file=path.join(f.root,"data/orca-execution-v1/new-task.release.json");
  const read=fs.readSync;let captured=-1;
  vi.spyOn(fs,"readSync").mockImplementationOnce(((fd:number,...args:any[])=>{
    captured=fd;const bytes=fs.readFileSync(file);fs.renameSync(file,path.join(f.root,"old"));
    fs.writeFileSync(file,bytes,{mode:0o600});return (read as any)(fd,...args);
  }) as typeof fs.readSync);
  expect(()=>f.controller.store.read("new-task")).toThrow("EXECUTION_RELEASE_FILE_CHANGED");
  expect(()=>fs.fstatSync(captured)).toThrow();
});
