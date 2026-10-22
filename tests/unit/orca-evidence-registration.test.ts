import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { ProjectStore } from "../../src/projects/project-store.js";
import { persistOrcaBinding } from "../../src/integrations/orca-binding.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { registerOrcaEvidence } from "../../src/integrations/orca-evidence-registration.js";
import type { Task } from "../../src/tasks/task.js";

let root: string, store: ProjectStore, request: any;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orca-registration-"));
  store = new ProjectStore(root);
  await store.saveTask({id:"task",projectId:"project",title:"Synthetic registration",description:"",status:"DOING",
    owner:"codex",ownerId:"codex",ownerType:"AGENT",reviewer:"gemini",priority:"LOW",workspace:root,
    maxRounds:1,currentRound:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as Task);
  const binding = {agenthubTaskId:"task",projectId:"project",revision:"2",generation:1,runtimeId:"runtime",
    hostId:"local",runId:"run",taskId:"orca-task",dispatchId:"dispatch",workspaceId:"workspace",workspacePath:root,
    terminalHandle:"terminal",developer:"codex" as const,reviewer:"gemini" as const,provider:"codex" as const,ownerId:"codex",claimId:null};
  await persistOrcaBinding(store,binding);
  request = {taskId:"task",revision:2,generation:1,bindingDigest:parseOrcaCompletionBinding(JSON.stringify(binding)).digest,
    recordedAt:new Date().toISOString(),refs:[{label:"report",evidence:await store.putOrcaEvidence(Buffer.from("synthetic evidence, not real provider proof"))}]};
});
afterEach(async () => {await fs.rm(root,{recursive:true,force:true});});

it("registers synthetic evidence with real storage without changing task bytes or binding revision",async()=>{
  const filename=path.join(root,"data/tasks/task.json"), before=await fs.readFile(filename);
  const result=await registerOrcaEvidence(store,JSON.stringify(request));
  expect(result.canCompleteTask).toBe(false);
  expect(await fs.readFile(filename)).toEqual(before);
  await registerOrcaEvidence(new ProjectStore(root),JSON.stringify(request));
  expect((await store.getTaskEvents("task")).filter(e=>e.id===result.eventId)).toHaveLength(1);
  expect(await fs.readFile(filename)).toEqual(before);
});
it.each(["revision","generation","bindingDigest"])("rejects stale %s before event registration",async key=>{
  request[key]=key==="bindingDigest"?"0".repeat(64):99;
  await expect(registerOrcaEvidence(store,JSON.stringify(request))).rejects.toThrow("STALE_EVIDENCE_REGISTRATION");
  expect(await store.getTaskEvents("task")).toEqual([]);
});
it("rejects missing retained evidence before event registration",async()=>{
  request.refs[0].evidence.sha256="0".repeat(64);
  await expect(registerOrcaEvidence(store,JSON.stringify(request))).rejects.toThrow();
  expect(await store.getTaskEvents("task")).toEqual([]);
});
it.each(["extra","duplicate-label","oversize","duplicate-json"])("rejects invalid input %s",async kind=>{
  let raw=JSON.stringify(request);
  if(kind==="extra") raw=JSON.stringify({...request,approved:true});
  if(kind==="duplicate-label") raw=JSON.stringify({...request,refs:[request.refs[0],request.refs[0]]});
  if(kind==="oversize") raw=" ".repeat(32769);
  if(kind==="duplicate-json") raw=raw.replace('"taskId":"task"','"taskId":"task","taskId":"task"');
  await expect(registerOrcaEvidence(store,raw)).rejects.toThrow("INVALID_EVIDENCE_REGISTRATION");
});
it("does not append while another execution holds authority",async()=>{
  await store.runTaskExecutionExclusive("task",async()=>{
    await expect(registerOrcaEvidence(store,JSON.stringify(request))).rejects.toThrow();
  });
  expect(await store.getTaskEvents("task")).toEqual([]);
});

it("rejects a concurrent administrative change during evidence reads without overwriting it",async()=>{
  const original=store.readOrcaEvidence.bind(store);
  store.readOrcaEvidence=async ref=>{
    const bytes=await original(ref);
    const task=(await store.getTask("task"))!;
    task.status="CANCELLED";
    await store.saveTask(task);
    return bytes;
  };
  await expect(registerOrcaEvidence(store,JSON.stringify(request))).rejects.toThrow("EVIDENCE_REGISTRATION_DRIFT");
  expect((await store.getTask("task"))?.status).toBe("CANCELLED");
  expect(await store.getTaskEvents("task")).toEqual([]);
});

it("does not treat a changed request as replay of an earlier evidence set",async()=>{
  const first=await registerOrcaEvidence(store,JSON.stringify(request));
  request.refs[0].evidence=await store.putOrcaEvidence(Buffer.from("different synthetic evidence"));
  const second=await registerOrcaEvidence(store,JSON.stringify(request));
  expect(first.eventId).not.toBe(second.eventId);
  expect(await store.getTaskEvents("task")).toHaveLength(2);
  expect((await store.getTask("task"))?.revision).toBe(2);
});

it.each(["append-acknowledgement","verification"])("exact retry reconciles uncertain %s without task mutation",async phase=>{
  const filename=path.join(root,"data/tasks/task.json"), before=await fs.readFile(filename);
  const append=store.appendTaskEventOnce.bind(store), verify=store.verifyTaskEventReadOnly.bind(store);
  let failed=false;
  if(phase==="append-acknowledgement") store.appendTaskEventOnce=async event=>{
    const result=await append(event);
    if(!failed){failed=true;throw new Error("synthetic uncertain append");}
    return result;
  };
  else store.verifyTaskEventReadOnly=async event=>{
    await verify(event);
    if(!failed){failed=true;throw new Error("synthetic uncertain verification");}
  };
  await expect(registerOrcaEvidence(store,JSON.stringify(request))).rejects.toThrow("synthetic uncertain");
  expect(await fs.readFile(filename)).toEqual(before);
  await registerOrcaEvidence(store,JSON.stringify(request));
  expect(await store.getTaskEvents("task")).toHaveLength(1);
  expect(await fs.readFile(filename)).toEqual(before);
});
