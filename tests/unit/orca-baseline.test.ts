import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe,it,expect,beforeEach,afterEach } from "vitest";
import { GitService } from "../../src/git/git-service.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import { persistOrcaBinding,persistOrcaBindingWithBaseline } from "../../src/integrations/orca-binding.js";
import { inspectOrcaFileAttribution } from "../../src/integrations/orca-baseline.js";
import type { Task } from "../../src/tasks/task.js";
import type { OrcaBinding } from "../../src/integrations/orca-delivery.js";
let root:string,repo:string,store:ProjectStore,binding:OrcaBinding;
beforeEach(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'orca-baseline-'));repo=path.join(root,'repo');await fs.mkdir(repo);
  store=new ProjectStore(path.join(root,'registry'));
  for(const args of [['init'],['config','user.email','synthetic@example.invalid'],['config','user.name','Synthetic']]) expect((await GitService.exec(args,repo)).exitCode).toBe(0);
  await fs.writeFile(path.join(repo,'source.ts'),'unchanged');
  expect((await GitService.exec(['add','.'],repo)).exitCode).toBe(0);
  expect((await GitService.exec(['commit','-m','synthetic baseline'],repo)).exitCode).toBe(0);
  await fs.writeFile(path.join(repo,'test.ts'),'existing untracked test');
  const task:Task={id:'task',projectId:'project',title:'Synthetic baseline',description:'',status:'DOING',owner:'gemini',ownerId:'gemini',ownerType:'AGENT',reviewerId:'codex',priority:'LOW',workspace:repo,maxRounds:1,currentRound:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await store.saveTask(task);
  binding={agenthubTaskId:'task',projectId:'project',revision:'2',generation:1,runtimeId:'runtime',hostId:'local',runId:'run',taskId:'orca-task',dispatchId:'dispatch',workspaceId:'workspace',workspacePath:repo,terminalHandle:'terminal',developer:'gemini',reviewer:'codex',provider:'antigravity',ownerId:'gemini',claimId:null};
});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
describe('pre-binding baseline (synthetic task, real temporary Git)',()=>{
  it.each(['unsupported\\name.ts','unsupported\nname.ts'])('leaves task unbound for unsupported inventory filename %j',async(name)=>{
    const before=await store.getTask('task');
    await fs.writeFile(path.join(repo,name),'unsupported filename');
    await expect(persistOrcaBindingWithBaseline(store,binding,['test.ts'])).rejects.toMatchObject({code:'INVALID_BASELINE_EVIDENCE'});
    expect(await store.getTask('task')).toEqual(before);
  });
  it('attributes edits to an existing untracked file as MODIFIED, not ADDED',async()=>{
    await persistOrcaBindingWithBaseline(store,binding,['test.ts']);
    expect((await inspectOrcaFileAttribution(store,'task')).changedFiles).toEqual([]);
    await fs.writeFile(path.join(repo,'test.ts'),'new assertions');
    expect(await inspectOrcaFileAttribution(store,'task')).toMatchObject({changedFiles:['test.ts'],changes:[{file:'test.ts',kind:'MODIFIED'}],withinWhitelist:true,canCompleteTask:false});
  });
  it('detects added, deleted, out-of-scope and mode changes',async()=>{
    await persistOrcaBindingWithBaseline(store,binding,['new.ts']);
    await fs.writeFile(path.join(repo,'new.ts'),'new');await fs.unlink(path.join(repo,'test.ts'));await fs.chmod(path.join(repo,'source.ts'),0o755);
    expect(await inspectOrcaFileAttribution(store,'task')).toMatchObject({changedFiles:['new.ts','source.ts','test.ts'],outsideWhitelist:['source.ts','test.ts'],withinWhitelist:false});
  });
  it('does not backfill a legacy binding or change task on invalid whitelist',async()=>{
    const before=await store.getTask('task');
    await expect(persistOrcaBindingWithBaseline(store,binding,['../escape'])).rejects.toThrow();
    expect(await store.getTask('task')).toEqual(before);
    await persistOrcaBinding(store,binding);
    await expect(inspectOrcaFileAttribution(store,'task')).rejects.toMatchObject({code:'BASELINE_NOT_CAPTURED'});
    const bound=(await store.getTask('task'))!;
    await expect(store.saveTask({...bound,orcaBaseline:{} as any})).rejects.toMatchObject({code:'BASELINE_IMMUTABLE'});
    await expect(persistOrcaBindingWithBaseline(store,{...binding,revision:'3'},['test.ts'])).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  });
  it('fences replacement/removal of a saved baseline through generic writers',async()=>{
    const task=await persistOrcaBindingWithBaseline(store,binding,['test.ts']);
    await expect(store.saveTask({...task,orcaBaseline:undefined})).rejects.toMatchObject({code:'BASELINE_IMMUTABLE'});
    await expect(store.saveTask({...task,orcaBaseline:{...task.orcaBaseline!,workspaceHash:'a'.repeat(64)}})).rejects.toMatchObject({code:'BASELINE_IMMUTABLE'});
    expect(await store.getTask('task')).toEqual(task);
  });
  it('rejects corrupt baseline bytes and a changed HEAD',async()=>{
    const task=await persistOrcaBindingWithBaseline(store,binding,['test.ts']);
    expect((await GitService.exec(['commit','--allow-empty','-m','changed head'],repo)).exitCode).toBe(0);
    await expect(inspectOrcaFileAttribution(store,'task')).rejects.toMatchObject({code:'BASELINE_HEAD_CHANGED'});
    const evidence=task.orcaBaseline!.evidence;
    await fs.writeFile(path.join(root,'registry/data/orca-evidence-v1',evidence.sha256),'corrupt');
    await expect(inspectOrcaFileAttribution(store,'task')).rejects.toThrow();
  });
});
