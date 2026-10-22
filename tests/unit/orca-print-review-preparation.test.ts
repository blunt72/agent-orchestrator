import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const collector = vi.hoisted(()=>vi.fn());
vi.mock("../../src/integrations/orca-collector.js",()=>({collectOrcaWorker:collector}));
import { ProjectStore } from "../../src/projects/project-store.js";
import { GitService } from "../../src/git/git-service.js";
import { persistOrcaBindingWithBaseline } from "../../src/integrations/orca-binding.js";
import { importOrcaDelivery, projectOrcaDelivery } from "../../src/integrations/orca-import.js";
import { fingerprintOrcaWorkspace, runOrcaDeliveryTests } from "../../src/integrations/orca-tests.js";
import { hashOrcaTestRun, reviewOrcaDelivery } from "../../src/integrations/orca-review.js";
import { prepareOrcaPrintReview, prepareOrcaPrintReviewRecovery } from "../../src/integrations/orca-print-review-preparation.js";
import { capturePreparedOrcaPrintReview, capturePreparedOrcaPrintRecovery } from "../../src/integrations/orca-print-review-capture.js";
import { finalizeOrcaPrintReview, finalizeOrcaPrintRecovery, hashOrcaPrintCapture } from "../../src/integrations/orca-print-review-finalization.js";
import type { Task } from "../../src/tasks/task.js";
import { inspectOrcaPrintCompletionReadiness } from "../../src/integrations/orca-print-completion-readiness.js";
import { OrcaReadOnlyStore } from "../../src/integrations/orca-read-only-store.js";
let root:string, store:ProjectStore;
beforeEach(async(context)=> {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"print-prepare-"))); store = new ProjectStore(root);
  await fs.writeFile(path.join(root,".gitignore"),"data/\nlogs/\n");
  await fs.writeFile(path.join(root,"test.cjs"),context.task.name.includes("silent") ? "" : 'console.log("synthetic test output");');
  for(const args of [["init"],["add",".gitignore","test.cjs"],["-c","user.name=Fixture","-c","user.email=test@example.invalid","commit","-m","fixture"]])
    expect((await GitService.exec(args,root)).exitCode).toBe(0);
  const now = new Date().toISOString();
  await store.saveTask({id:"task",projectId:"project",title:context.task.name.includes("explicit read profile")?"read-profile"+(context.task.name.includes("wrong verdict")?"-invalid":context.task.name.includes("request changes")?"-request-changes":"")+(context.task.name.includes("fenced")?"-fenced":""):"Synthetic print preparation",description:"test only",status:"DOING",
    owner:"codex",ownerId:"codex",ownerType:"AGENT",reviewerId:"gemini",priority:"LOW",workspace:root,
    maxRounds:1,currentRound:0,createdAt:now,updatedAt:now,testCommand:"node test.cjs"} as Task);
  await persistOrcaBindingWithBaseline(store,{agenthubTaskId:"task",projectId:"project",revision:"2",generation:1,
    runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",dispatchId:"dispatch",workspaceId:"workspace",
    workspacePath:root,terminalHandle:"terminal",developer:"codex",reviewer:"gemini",provider:"codex",ownerId:"codex",claimId:null},["test.cjs"]);
  if(context.task.name.includes("explicit read profile"))await fs.appendFile(path.join(root,"test.cjs"),"\n// synthetic scoped developer change\n");
  if(context.task.name.includes("unsafe files in explicit read profile"))await fs.chmod(path.join(root,"test.cjs"),0o666);
  const receipt={ok:true,_meta:{runtimeId:"runtime"},result:{
    dispatch:{id:"dispatch",runId:"run",taskId:"orca-task",assigneeHandle:"terminal",hostScope:{kind:"local",hostId:"local"},status:"completed",completedAt:now},
    worker:{dispatchId:"dispatch",runtimeEpoch:"runtime",worktreeId:"workspace",agentTerminalHandle:"terminal",startOptions:{agent:"codex"},state:"succeeded",stage:"settled"},
    projection:{id:"dispatch",dispatchId:"dispatch",taskId:"orca-task",runId:"run",role:"worker",host:{kind:"local",id:"local"},
      workspace:{id:"workspace"},provider:{id:"codex"},outcome:"succeeded",stage:{dispatch:"completed",worker:"succeeded"},evidence:{durable:true}},
    terminal:{handle:"terminal",worktreeId:"workspace",worktreePath:root}}};
  collector.mockReset();collector.mockResolvedValue({ok:true,receipt,stdoutSha256:"a".repeat(64),bytes:100,provenance:"LOCAL_CLI_OBSERVATION"});
  await importOrcaDelivery(store,"/synthetic/orca","task",{id:"message",type:"worker_done",run_id:"run",from_handle:"terminal",to_handle:"run:run",
    body:"synthetic",payload:{taskId:"orca-task",dispatchId:"dispatch",outcome:"succeeded"}});
  await projectOrcaDelivery(store,"task");
  const task=(await store.getTask("task"))!;
  await runOrcaDeliveryTests(store,"task",{revision:task.revision!,generation:1,digest:task.orcaDelivery!.digest,
    workspaceHash:await fingerprintOrcaWorkspace(root),command:"node test.cjs"});
});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
async function approval(){const t=(await store.getTask("task"))!;return {revision:t.revision!,generation:1,digest:t.orcaDelivery!.digest,
  workspaceHash:t.orcaTestRun!.workspaceHash,testRunHash:hashOrcaTestRun(t.orcaTestRun!),requirements:await store.putOrcaEvidence(Buffer.from("Synthetic requirements: inspect test assertions."))};}
it("persists exact request and immutable subjects without launching a reviewer",async()=> {
  const a=await approval(), p=await prepareOrcaPrintReview(store,"task",a), t=(await store.getTask("task"))!;
  expect(p.preparedRevision).toBe(a.revision+1);expect(t.revision).toBe(p.preparedRevision);expect(t.status).toBe("REVIEW");
  const request=JSON.parse((await store.readOrcaEvidence(p.request)).toString());
  expect(request.expected).toEqual(p.subjects);expect(request.requestId).toBe(p.requestId);expect(request.requirements).toContain("Synthetic requirements");
  expect(t.orcaReviewRun).toBeUndefined();expect(p.canFinalizeReview).toBe(false);
  await expect(prepareOrcaPrintReview(store,"task",{...a,revision:t.revision!})).rejects.toThrow("PRINT_PREPARATION_NOT_READY");
});
it.each(["revision","testRunHash","workspaceHash"])("rejects stale %s",async field=> {
  const a=await approval();(a as any)[field]=field === "revision" ? a.revision-1 : "b".repeat(64);
  await expect(prepareOrcaPrintReview(store,"task",a)).rejects.toThrow();expect((await store.getTask("task"))!.orcaPrintReviewPreparation).toBeUndefined();
});
it("preserves cancellation and rejects preparation",async()=> {
  const a=await approval(),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);
  await expect(prepareOrcaPrintReview(store,"task",{...a,revision:t.revision!})).rejects.toThrow();expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it("rejects out-of-whitelist drift",async()=> {
  const a=await approval();await fs.writeFile(path.join(root,"unexpected.txt"),"drift");
  await expect(prepareOrcaPrintReview(store,"task",a)).rejects.toThrow();
});
it("cannot delete or mutate preparation but permits cancellation",async()=> {
  await prepareOrcaPrintReview(store,"task",await approval());const t=(await store.getTask("task"))!;
  const deleted=structuredClone(t);delete deleted.orcaPrintReviewPreparation;await expect(store.saveTask(deleted)).rejects.toThrow("PRINT_PREPARATION_IMMUTABLE");
  const changed=structuredClone(t);changed.orcaPrintReviewPreparation!.requestId="other";await expect(store.saveTask(changed)).rejects.toThrow("PRINT_PREPARATION_IMMUTABLE");
  t.status="CANCELLED";await store.saveTask(t);expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it("blocks legacy review before it initializes an adapter",async()=> {
  await prepareOrcaPrintReview(store,"task",await approval());const t=(await store.getTask("task"))!;
  const initialize=vi.fn();const reviewer={name:"gemini",initialize} as any;
  await expect(reviewOrcaDelivery(store,"task",reviewer,{...await approval(),revision:t.revision!})).rejects.toThrow("REVIEW_ALREADY_STARTED");
  expect(initialize).not.toHaveBeenCalled();
});
it("rejects concurrent cancellation during evidence retention",async()=> {
  const a=await approval(), original=store.putOrcaEvidence.bind(store);
  vi.spyOn(store,"putOrcaEvidence").mockImplementationOnce(async bytes=>{
    const ref=await original(bytes),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);return ref;
  });
  await expect(prepareOrcaPrintReview(store,"task",a)).rejects.toThrow("PRINT_PREPARATION_SNAPSHOT_CHANGED");
  expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it("permits successful silent tests with zero retained output bytes",async()=> {
  const p=await prepareOrcaPrintReview(store,"task",await approval());expect(p.testOutput.bytes).toBe(0);
  expect(JSON.parse((await store.readOrcaEvidence(p.request)).toString()).testOutput).toBe("");
});
it.each(["orcaReviewHistory","orcaRevalidationHistory"])("rejects archived %s records",async field=> {
  const t=(await store.getTask("task"))!;(t as any)[field]=[];await store.saveTask(t);
  await expect(prepareOrcaPrintReview(store,"task",await approval())).rejects.toThrow("PRINT_PREPARATION_NOT_READY");
});
it("preserves cancellation racing the final CAS save",async()=> {
  const a=await approval(),save=store.saveTask.bind(store);
  vi.spyOn(store,"saveTask").mockImplementationOnce(async candidate=> {
    const cancelled=(await store.getTask("task"))!;cancelled.status="CANCELLED";await save(cancelled);await save(candidate);
  });
  await expect(prepareOrcaPrintReview(store,"task",a)).rejects.toThrow("CONFLICT");
  const t=(await store.getTask("task"))!;expect(t.status).toBe("CANCELLED");expect(t.orcaPrintReviewPreparation).toBeUndefined();
});
it("retains the original checkpoint after an uncertain save reply",async()=> {
  const a=await approval(),save=store.saveTask.bind(store);
  vi.spyOn(store,"saveTask").mockImplementationOnce(async candidate=> {await save(candidate);throw new Error("SAVE_REPLY_LOST");});
  await expect(prepareOrcaPrintReview(store,"task",a)).rejects.toThrow("SAVE_REPLY_LOST");
  const t=(await store.getTask("task"))!,id=t.orcaPrintReviewPreparation!.requestId;
  await expect(prepareOrcaPrintReview(store,"task",await approval())).rejects.toThrow("PRINT_PREPARATION_NOT_READY");
  expect((await store.getTask("task"))!.orcaPrintReviewPreparation!.requestId).toBe(id);
});
async function captureSetup() {
  const p=await prepareOrcaPrintReview(store,"task",await approval());
  const executable=path.join(root,"data/fixture");
  await fs.copyFile(path.resolve("tests/fixtures/antigravity-print-process.mjs"),executable);await fs.chmod(executable,0o700);
  const evidenceRoot=path.join(root,"data/captures");await fs.mkdir(evidenceRoot,{mode:0o700});
  return {p,a:{revision:p.preparedRevision,requestId:p.requestId,requestSha256:p.request.sha256},c:{executable,evidenceRoot,timeoutMs:3000}};
}
async function failedRecoverySetup(){
  const {a,c,p}=await captureSetup();
  await fs.writeFile(c.executable,'#!/usr/bin/env node\nprocess.stdout.write("{}\\n");\n');
  const failed=await capturePreparedOrcaPrintReview(store,"task",a,c);
  expect(failed.status).toBe("FAILED");
  return {p,failed,c,a:{...await approval(),previousRequestId:p.requestId,failedCaptureHash:hashOrcaPrintCapture(failed)}};
}
async function recoveryCaptureSetup(){
  const {a,c}=await failedRecoverySetup();
  const before=(await store.getTask("task"))!;
  const p=await prepareOrcaPrintReviewRecovery(store,"task",a);
  await fs.copyFile(path.resolve("tests/fixtures/antigravity-print-process.mjs"),c.executable);
  await fs.chmod(c.executable,0o700);
  return {before,p,c:{...c,readOnlyPaths:[root+"/test.cjs"]},a:{revision:p.preparedRevision,requestId:p.requestId,requestSha256:p.request.sha256}};
}
it.each(["pass","request changes","fenced"])("finalizes separate explicit read profile recovery %s without rewriting failure",async kind=>{
  const {a,c,before}=await recoveryCaptureSetup();
  const captured=await capturePreparedOrcaPrintRecovery(store,"task",a,c),t=(await store.getTask("task"))!;
  expect(captured.status,(await store.readOrcaEvidence(captured.files.process)).toString()).toBe("CAPTURED");
  const approval={revision:t.revision!,requestId:a.requestId,captureHash:hashOrcaPrintCapture(captured),
    ...(kind==="fenced"?{responseFormat:"json-fence-v1" as const}:{})};
  if(kind==="fenced"){
    await expect(finalizeOrcaPrintRecovery(store,"task",{...approval,responseFormat:undefined})).rejects.toThrow("INVALID_PRINT_REVIEW_RESPONSE");
    expect((await store.getTask("task"))!.revision).toBe(t.revision);
  }
  const result=await finalizeOrcaPrintRecovery(store,"task",approval),after=(await store.getTask("task"))!;
  expect(result.verdict).toBe(kind==="request changes"?"REQUEST_CHANGES":"PASS");expect(after.status).toBe("REVIEW");expect(result.canCompleteTask).toBe(false);
  if(kind==="fenced"){
    expect((await store.readOrcaEvidence(result.response)).toString()).toMatch(/^```json\n/);
    expect(result.responseFormat).toBe("json-fence-v1");
    await expect(finalizeOrcaPrintRecovery(store,"task",{...approval,responseFormat:"raw-json-v1"})).rejects.toThrow("STALE_PRINT_FINALIZATION");
  }
  for(const key of ["orcaPrintReviewPreparation","orcaPrintCaptureIntent","orcaPrintCaptureResult"] as const)expect(after[key]).toEqual(before[key]);
  expect(after.orcaPrintReviewFinalization).toBeUndefined();
  expect(await finalizeOrcaPrintRecovery(store,"task",approval)).toEqual(result);
  const readinessExpectation={revision:after.revision!,attempt:"recovery" as const,finalizationHash:createHash("sha256").update(JSON.stringify(result)).digest("hex")};
  if(kind==="request changes")await expect(inspectOrcaPrintCompletionReadiness(root,"task",readinessExpectation)).rejects.toThrow();
  else{
    const fileBefore=await fs.readFile(path.join(root,"data/tasks/task.json"));
    const ready=await inspectOrcaPrintCompletionReadiness(root,"task",readinessExpectation);
    expect(ready.reviewEvidenceReady).toBe(true);expect(ready.canCompleteTask).toBe(false);expect(ready.approvalIssued).toBe(false);
    expect(await fs.readFile(path.join(root,"data/tasks/task.json"))).toEqual(fileBefore);
    for(const bad of [{...readinessExpectation,revision:after.revision!-1},{...readinessExpectation,finalizationHash:"b".repeat(64)},
      {...readinessExpectation,attempt:"initial" as const}])await expect(inspectOrcaPrintCompletionReadiness(root,"task",bad)).rejects.toThrow();
    const taskFile=path.join(root,"data/tasks/task.json");
    const alternate=await store.putOrcaEvidence(Buffer.from("different requirements"));
    for(const kind of ["requirements","title","old-intent","old-subjects","old-request"]){
      const tampered=structuredClone(after);
      if(kind==="requirements")tampered.orcaPrintRecoveryPreparation!.preparation.requirements=alternate;
      if(kind==="title")tampered.title="changed after review";
      if(kind==="old-intent")delete tampered.orcaPrintCaptureIntent;
      if(kind==="old-subjects")tampered.orcaPrintReviewPreparation!.subjects.testRunId="other";
      if(kind==="old-request")tampered.orcaPrintCaptureIntent!.requestSha256="b".repeat(64);
      await fs.writeFile(taskFile,JSON.stringify(tampered));
      await expect(inspectOrcaPrintCompletionReadiness(root,"task",readinessExpectation)).rejects.toThrow();
      await fs.writeFile(taskFile,fileBefore);
    }
    const log=path.join(root,"logs/tasks/task.jsonl"),backup=log+".backup";
    await fs.rename(log,backup);await fs.symlink(backup,log);
    await expect(inspectOrcaPrintCompletionReadiness(root,"task",readinessExpectation)).rejects.toThrow();
    await fs.unlink(log);execFileSync("mkfifo",[log]);
    await expect(inspectOrcaPrintCompletionReadiness(root,"task",readinessExpectation)).rejects.toThrow();
    await fs.unlink(log);await fs.rename(backup,log);
    const inode=fsSync.statSync(log).ino,readSync=fsSync.readSync;let replaced=false;
    const spy=vi.spyOn(fsSync,"readSync").mockImplementation(((...args:any[])=>{
      const n=(readSync as any)(...args);
      if(!replaced&&fsSync.fstatSync(args[0]).ino===inode){replaced=true;fsSync.renameSync(log,backup);fsSync.copyFileSync(backup,log);}
      return n;
    }) as any);
    await expect(inspectOrcaPrintCompletionReadiness(root,"task",readinessExpectation)).rejects.toThrow();
    spy.mockRestore();expect(replaced).toBe(true);await fs.unlink(log);await fs.rename(backup,log);
    await fs.writeFile(path.join(root,"unexpected.txt"),"drift");
    await expect(inspectOrcaPrintCompletionReadiness(root,"task",readinessExpectation)).rejects.toThrow();
    await fs.unlink(path.join(root,"unexpected.txt"));
  }
  await expect(capturePreparedOrcaPrintRecovery(store,"task",{...a,revision:after.revision!},c)).rejects.toThrow();
  for(const key of ["orcaPrintRecoveryCaptureIntent","orcaPrintRecoveryCaptureResult","orcaPrintRecoveryFinalization"] as const){
    const removed=structuredClone(after);delete removed[key];await expect(store.saveTask(removed)).rejects.toThrow("PRINT_PREPARATION_IMMUTABLE");
  }
});
it("rejects cancellation during explicit read profile recovery readiness without writing",async()=>{
  const {a,c}=await recoveryCaptureSetup(),captured=await capturePreparedOrcaPrintRecovery(store,"task",a,c),t=(await store.getTask("task"))!;
  const f=await finalizeOrcaPrintRecovery(store,"task",{revision:t.revision!,requestId:a.requestId,captureHash:hashOrcaPrintCapture(captured)});
  const after=(await store.getTask("task"))!,read=OrcaReadOnlyStore.prototype.readOrcaEvidence;
  vi.spyOn(OrcaReadOnlyStore.prototype,"readOrcaEvidence").mockImplementationOnce(async function(this:OrcaReadOnlyStore,ref){
    const bytes=await read.call(this,ref),cancelled=(await store.getTask("task"))!;cancelled.status="CANCELLED";await store.saveTask(cancelled);return bytes;
  });
  await expect(inspectOrcaPrintCompletionReadiness(root,"task",{revision:after.revision!,attempt:"recovery",finalizationHash:createHash("sha256").update(JSON.stringify(f)).digest("hex")})).rejects.toThrow();
  expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it("rejects explicit read profile recovery capture without scope before consuming attempt",async()=>{
  const {a,c}=await recoveryCaptureSetup();delete (c as any).readOnlyPaths;
  await expect(capturePreparedOrcaPrintRecovery(store,"task",a,c)).rejects.toThrow("PRINT_RECOVERY_NOT_READY");
  expect((await store.getTask("task"))!.orcaPrintRecoveryCaptureIntent).toBeUndefined();
});
it("preserves cancellation during explicit read profile recovery capture retention",async()=>{
  const {a,c}=await recoveryCaptureSetup(),put=store.putOrcaEvidence.bind(store);
  vi.spyOn(store,"putOrcaEvidence").mockImplementationOnce(async bytes=>{
    const ref=await put(bytes),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);return ref;
  });
  await expect(capturePreparedOrcaPrintRecovery(store,"task",a,c)).rejects.toThrow("PRINT_CAPTURE_TASK_CHANGED_OR_CANCELLED");
  const t=(await store.getTask("task"))!;expect(t.status).toBe("CANCELLED");expect(t.orcaPrintRecoveryCaptureResult).toBeUndefined();
  expect(t.orcaPrintCaptureResult!.status).toBe("FAILED");
});
it("prepares explicit recovery preserving every consumed-attempt record",async()=>{
  const {a,p}=await failedRecoverySetup(),before=(await store.getTask("task"))!;
  const next=await prepareOrcaPrintReviewRecovery(store,"task",a),after=(await store.getTask("task"))!;
  expect(next.requestId).not.toBe(p.requestId);expect(next.subjects.reviewId).not.toBe(p.subjects.reviewId);
  expect(after.revision).toBe(before.revision!+1);expect(after.status).toBe("REVIEW");
  for(const key of ["orcaPrintReviewPreparation","orcaPrintCaptureIntent","orcaPrintCaptureResult"] as const)expect(after[key]).toEqual(before[key]);
  expect(after.orcaPrintRecoveryPreparation!.failedCaptureHash).toBe(a.failedCaptureHash);
  expect(after.orcaPrintRecoveryPreparation!.automaticRetry).toBe(false);
  const removed=structuredClone(after);delete removed.orcaPrintRecoveryPreparation;
  await expect(store.saveTask(removed)).rejects.toThrow("PRINT_PREPARATION_IMMUTABLE");
  await expect(prepareOrcaPrintReviewRecovery(store,"task",{...a,revision:after.revision!})).rejects.toThrow();
});
it.each(["hash","request","revision","workspace"])("rejects recovery with stale %s",async kind=>{
  const {a}=await failedRecoverySetup();
  if(kind==="hash")a.failedCaptureHash="b".repeat(64);
  if(kind==="request")a.previousRequestId="11111111-1111-1111-1111-111111111111";
  if(kind==="revision")a.revision--;
  if(kind==="workspace")await fs.writeFile(path.join(root,"unexpected.txt"),"drift");
  await expect(prepareOrcaPrintReviewRecovery(store,"task",a)).rejects.toThrow();
  expect((await store.getTask("task"))!.orcaPrintRecoveryPreparation).toBeUndefined();
});
it("preserves cancellation racing recovery evidence retention",async()=>{
  const {a}=await failedRecoverySetup(),put=store.putOrcaEvidence.bind(store);
  vi.spyOn(store,"putOrcaEvidence").mockImplementationOnce(async bytes=>{
    const ref=await put(bytes),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);return ref;
  });
  await expect(prepareOrcaPrintReviewRecovery(store,"task",a)).rejects.toThrow("PRINT_PREPARATION_SNAPSHOT_CHANGED");
  expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it.each(["request-hash","subjects","intent-model","version","pid","closure","stdout-hash","failure","extra"])("rejects inconsistent recovery bundle %s",async kind=>{
  const {a}=await failedRecoverySetup(),t=(await store.getTask("task"))!;
  if(kind==="request-hash")t.orcaPrintCaptureIntent!.requestSha256="b".repeat(64);
  else if(kind==="subjects")t.orcaPrintReviewPreparation!.subjects.testRunId="other";
  else {
    const key=kind==="intent-model"?"intent":"process",c=t.orcaPrintCaptureResult!;
    const data=JSON.parse((await store.readOrcaEvidence(c.files[key])).toString());
    if(kind==="intent-model")data.model="gemini-3.8-flash-low";
    if(kind==="version")data.version=2;
    if(kind==="pid")delete data.pid;
    if(kind==="closure")delete data.closedAt;
    if(kind==="stdout-hash")data.stdoutSha256="b".repeat(64);
    if(kind==="failure")data.failure="TIMEOUT";
    if(kind==="extra")data.extra=true;
    c.files[key]=await store.putOrcaEvidence(Buffer.from(JSON.stringify(data)));
    a.failedCaptureHash=hashOrcaPrintCapture(c);
  }
  vi.spyOn(store,"getTask").mockResolvedValue(t);
  await expect(prepareOrcaPrintReviewRecovery(store,"task",a)).rejects.toThrow();
  expect(t.orcaPrintRecoveryPreparation).toBeUndefined();
});
it("captures a prepared request exactly once using a real synthetic child process",async()=> {
  const {p,a,c}=await captureSetup(),r=await capturePreparedOrcaPrintReview(store,"task",a,c),t=(await store.getTask("task"))!;
  expect(r.status).toBe("CAPTURED");expect(t.status).toBe("REVIEW");expect(t.orcaReviewRun).toBeUndefined();expect(r.canFinalizeReview).toBe(false);
  expect(await store.readOrcaEvidence(r.files.request)).toEqual(await store.readOrcaEvidence(p.request));
  await expect(capturePreparedOrcaPrintReview(store,"task",{...a,revision:t.revision!},c)).rejects.toThrow("PRINT_CAPTURE_NOT_READY");
  const deleted=structuredClone(t);delete deleted.orcaPrintCaptureIntent;await expect(store.saveTask(deleted)).rejects.toThrow("PRINT_PREPARATION_IMMUTABLE");
});
it("does not launch after an uncertain capture-intent save",async()=> {
  const {a,c,p}=await captureSetup(),save=store.saveTask.bind(store);
  vi.spyOn(store,"saveTask").mockImplementationOnce(async t=>{await save(t);throw new Error("CAPTURE_REPLY_LOST");});
  await expect(capturePreparedOrcaPrintReview(store,"task",a,c)).rejects.toThrow("CAPTURE_REPLY_LOST");
  await expect(fs.stat(path.join(c.evidenceRoot,p.requestId))).rejects.toThrow();
  const t=(await store.getTask("task"))!;expect(t.orcaPrintCaptureIntent).toBeDefined();
  await expect(capturePreparedOrcaPrintReview(store,"task",{...a,revision:t.revision!},c)).rejects.toThrow();
});
it("does not launch a cancelled prepared task",async()=> {
  const {a,c,p}=await captureSetup(),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);
  await expect(capturePreparedOrcaPrintReview(store,"task",{...a,revision:t.revision!},c)).rejects.toThrow();
  await expect(fs.stat(path.join(c.evidenceRoot,p.requestId))).rejects.toThrow();
});
it("preserves cancellation during capture retention and leaves raw evidence",async()=> {
  const {a,c,p}=await captureSetup(),put=store.putOrcaEvidence.bind(store);
  vi.spyOn(store,"putOrcaEvidence").mockImplementationOnce(async bytes=>{
    const ref=await put(bytes),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);return ref;
  });
  await expect(capturePreparedOrcaPrintReview(store,"task",a,c)).rejects.toThrow("PRINT_CAPTURE_TASK_CHANGED_OR_CANCELLED");
  const t=(await store.getTask("task"))!;expect(t.status).toBe("CANCELLED");expect(t.orcaPrintCaptureResult).toBeUndefined();
  expect((await fs.stat(path.join(c.evidenceRoot,p.requestId,"stdout.bin"))).size).toBeGreaterThan(0);
});
it("retains failed process evidence and consumes its capture attempt",async()=> {
  const {a,c}=await captureSetup();await fs.chmod(c.executable,0o600);
  const r=await capturePreparedOrcaPrintReview(store,"task",a,c);expect(r.status).toBe("FAILED");
  expect(JSON.parse((await store.readOrcaEvidence(r.files.process)).toString()).failure).toBe("SPAWN_ERROR");
  await expect(capturePreparedOrcaPrintReview(store,"task",{...a,revision:(await store.getTask("task"))!.revision!},c)).rejects.toThrow();
});
it("rejects a replaced capture file without granting result authority",async()=> {
  const {a,c}=await captureSetup(),lstat=fsSync.lstatSync.bind(fsSync);let replaced=false;
  vi.spyOn(fsSync,"lstatSync").mockImplementation(((file:any,options:any)=> {
    if(!replaced && String(file).endsWith("stdout.bin")) {
      replaced=true;fsSync.unlinkSync(file);fsSync.symlinkSync(path.join(path.dirname(String(file)),"request.bin"),file);
    }
    return lstat(file,options);
  }) as typeof fsSync.lstatSync);
  await expect(capturePreparedOrcaPrintReview(store,"task",a,c)).rejects.toThrow("UNSAFE_CAPTURE_FILE");
  expect((await store.getTask("task"))!.orcaPrintCaptureResult).toBeUndefined();
});
it("preserves cancellation racing the final capture-result CAS",async()=> {
  const {a,c,p}=await captureSetup(),save=store.saveTask.bind(store);let calls=0;
  vi.spyOn(store,"saveTask").mockImplementation(async candidate=> {
    if(++calls===2){const t=(await store.getTask("task"))!;t.status="CANCELLED";await save(t);}
    await save(candidate);
  });
  await expect(capturePreparedOrcaPrintReview(store,"task",a,c)).rejects.toThrow("CONFLICT");
  const t=(await store.getTask("task"))!;expect(t.status).toBe("CANCELLED");expect(t.orcaPrintCaptureResult).toBeUndefined();
  expect((await fs.stat(path.join(c.evidenceRoot,p.requestId,"process.json"))).size).toBeGreaterThan(0);
});
it("rejects read profile broader than attributed changed files before launch",async()=> {
  const {a,c,p}=await captureSetup();
  await expect(capturePreparedOrcaPrintReview(store,"task",a,{...c,readOnlyPaths:[root+"/test.cjs"]})).rejects.toThrow("PRINT_READ_SCOPE_MISMATCH");
  expect((await store.getTask("task"))!.orcaPrintCaptureIntent).toBeUndefined();
  await expect(fs.stat(path.join(c.evidenceRoot,p.requestId))).rejects.toThrow();
});
it("captures explicit read profile pinned to attributed changed files",async()=> {
  const {a,c}=await captureSetup(),r=await capturePreparedOrcaPrintReview(store,"task",a,{...c,readOnlyPaths:[root+"/test.cjs"]});
  expect(r.status).toBe("CAPTURED");expect(r.canFinalizeReview).toBe(false);
  const t=(await store.getTask("task"))!;expect(t.orcaPrintCaptureIntent!.profile).toEqual({kind:"view-file-v1",allowedPaths:[root+"/test.cjs"]});
  expect(JSON.parse((await store.readOrcaEvidence(r.files.process)).toString()).version).toBe(3);
  expect(t.orcaPrintCaptureIntent!.model).toBe("gemini-3.8-flash-high");
});
it("rejects unsafe files in explicit read profile before intent",async()=> {
  const {a,c}=await captureSetup();
  await expect(capturePreparedOrcaPrintReview(store,"task",a,{...c,readOnlyPaths:[root+"/test.cjs"]})).rejects.toThrow("UNSAFE_PRINT_READ_FILE");
  expect((await store.getTask("task"))!.orcaPrintCaptureIntent).toBeUndefined();
});
it("snapshots caller paths for explicit read profile before awaiting",async()=> {
  const {a,c}=await captureSetup(),paths=[root+"/test.cjs"];
  const pending=capturePreparedOrcaPrintReview(store,"task",a,{...c,readOnlyPaths:paths});paths[0]=root+"/other";
  expect((await pending).status).toBe("CAPTURED");
  expect((await store.getTask("task"))!.orcaPrintCaptureIntent!.profile!.allowedPaths).toEqual([root+"/test.cjs"]);
});
async function finalizationSetup(){
  const {a,c,p}=await captureSetup(),r=await capturePreparedOrcaPrintReview(store,"task",a,{...c,readOnlyPaths:[root+"/test.cjs"]});
  const task=(await store.getTask("task"))!;
  return {a:{revision:task.revision!,requestId:p.requestId,captureHash:hashOrcaPrintCapture(r)},r};
}
it("finalizes explicit read profile and identical replay without granting DONE",async()=> {
  const {a}=await finalizationSetup(),r=await finalizeOrcaPrintReview(store,"task",a),t=(await store.getTask("task"))!;
  expect(r.verdict).toBe("PASS");expect(r.finalizedRevision).toBe(a.revision+1);expect(t.status).toBe("REVIEW");expect(r.canCompleteTask).toBe(false);
  expect(await finalizeOrcaPrintReview(store,"task",a)).toEqual(r);expect((await store.getTask("task"))!.revision).toBe(t.revision);
  const changed=structuredClone(t);delete changed.orcaPrintReviewFinalization;await expect(store.saveTask(changed)).rejects.toThrow("PRINT_PREPARATION_IMMUTABLE");
});
it("records request changes for explicit read profile without completing task",async()=> {
  const {a}=await finalizationSetup();expect((await finalizeOrcaPrintReview(store,"task",a)).verdict).toBe("REQUEST_CHANGES");
  expect((await store.getTask("task"))!.status).toBe("REVIEW");
});
it("rejects wrong verdict in explicit read profile while retaining original evidence",async()=> {
  const {a,r}=await finalizationSetup();await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow("INVALID_PRINT_REVIEW_RESPONSE");
  expect((await store.readOrcaEvidence(r.files.stdout)).length).toBeGreaterThan(0);expect((await store.getTask("task"))!.orcaPrintReviewFinalization).toBeUndefined();
});
it("preserves cancellation before finalizing explicit read profile",async()=> {
  const {a}=await finalizationSetup(),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow();expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it("rejects workspace drift while finalizing explicit read profile",async()=> {
  const {a}=await finalizationSetup();await fs.appendFile(path.join(root,"test.cjs"),"\n// drift\n");
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow("PRINT_FINALIZATION_WORKSPACE_CHANGED");
});
it("preserves final CAS cancellation for explicit read profile",async()=> {
  const {a}=await finalizationSetup(),save=store.saveTask.bind(store);
  vi.spyOn(store,"saveTask").mockImplementationOnce(async candidate=>{const t=(await store.getTask("task"))!;t.status="CANCELLED";await save(t);await save(candidate);});
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow("CONFLICT");expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it("reconciles uncertain final save for explicit read profile without another launch",async()=> {
  const {a}=await finalizationSetup(),save=store.saveTask.bind(store);
  vi.spyOn(store,"saveTask").mockImplementationOnce(async candidate=>{await save(candidate);throw new Error("FINAL_REPLY_LOST");});
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow("FINAL_REPLY_LOST");
  const r=await finalizeOrcaPrintReview(store,"task",a);expect(r.verdict).toBe("PASS");expect(r.requestId).toBe(a.requestId);
});
it.each(["revision","captureHash"])("rejects stale %s for explicit read profile finalization",async field=> {
  const {a}=await finalizationSetup();(a as any)[field]=field==="revision"?a.revision-1:"b".repeat(64);
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow();expect((await store.getTask("task"))!.orcaPrintReviewFinalization).toBeUndefined();
});
it("preserves retention-time cancellation for explicit read profile",async()=> {
  const {a}=await finalizationSetup(),put=store.putOrcaEvidence.bind(store);
  vi.spyOn(store,"putOrcaEvidence").mockImplementationOnce(async bytes=>{const ref=await put(bytes),t=(await store.getTask("task"))!;t.status="CANCELLED";await store.saveTask(t);return ref;});
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow("PRINT_FINALIZATION_SNAPSHOT_CHANGED");
  expect((await store.getTask("task"))!.status).toBe("CANCELLED");
});
it("rejects corrupt retained output for explicit read profile",async()=> {
  const {a,r}=await finalizationSetup(),read=store.readOrcaEvidence.bind(store);
  vi.spyOn(store,"readOrcaEvidence").mockImplementation(ref=>ref.sha256===r.files.stdout.sha256?Promise.resolve(Buffer.from("{}\n")):read(ref));
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow();expect((await store.getTask("task"))!.orcaPrintReviewFinalization).toBeUndefined();
});
it("rejects explicit null model before formal capture intent",async()=> {
  const {a,c}=await captureSetup();await expect(capturePreparedOrcaPrintReview(store,"task",a,{...c,model:null as any})).rejects.toThrow("INVALID_PRINT_MODEL");
  expect((await store.getTask("task"))!.orcaPrintCaptureIntent).toBeUndefined();
});
it("rejects unpinned finalization for explicit read profile",async()=> {
  const {a}=await finalizationSetup(),get=store.getTask.bind(store);
  vi.spyOn(store,"getTask").mockImplementation(async id=>{const t=await get(id);delete (t!.orcaPrintCaptureIntent as any).model;return t;});
  await expect(finalizeOrcaPrintReview(store,"task",a)).rejects.toThrow("PRINT_FINALIZATION_NOT_READY");
});
