import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {GitService} from '../../src/git/git-service.js';
import {ProjectEngine} from '../../src/projects/project-engine.js';
import {TaskEngine} from '../../src/tasks/task-engine.js';
import {TaskRunner} from '../../src/tasks/task-runner.js';
import {GeminiTaskEventBridge,bindingFor} from '../../src/integrations/gemini-task-event-bridge.js';
import {verifyTranscriptRecovery} from '../../src/integrations/gemini-transcript-recovery.js';
import type {Task} from '../../src/tasks/task.js';
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true});});
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function setup(enabled=true){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2b-entry-'));roots.push(root);
 const initialize=vi.fn(async()=>{}),agent={initialize} as any;
 const options={baseDir:root,transcriptBridgeEnabled:enabled,transcriptBrainRoot:root,codexAgent:agent,geminiAgent:agent};
 const engine=new TaskEngine(options);
 const task={id:'T1',projectId:'P1',title:'synthetic',description:'',workspace:root,worktree:root,branch:'synthetic',status:'REVIEW',
  reviewerId:'gemini',ownerId:'gemini',owner:'gemini',ownerType:'AGENT',priority:'LOW',currentRound:1,maxRounds:2,
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
  pendingAgentTurn:{actor:'gemini',phase:'REVIEW',sessionId:'12345678-1234-1234-1234-123456789abc',startStepIndex:2,requestTime:'2026-10-17T10:00:00Z'}} as Task;
 await engine.getStore().saveTask(task);
 const bridge=new GeminiTaskEventBridge(path.join(root,'data/gemini-event-bridge'));
 return {root,engine,task,bridge,initialize,options};
}
function approve(root:string,task:Task,event:any){
 const report=path.join(root,'independent-review.txt');fs.writeFileSync(report,'Human checked original session identity and full response; safe to restore.');
 const shared={taskId:task.id,taskRevision:task.revision,eventId:event.id,binding:bindingFor(task)};
 const evidence={...shared,version:1,kind:'independent_original_turn_review',reviewedBy:'operator',reviewedAt:new Date().toISOString(),
 originalSessionIdentityChecked:true,fullTurnResponseChecked:true,safeToRestoreSavedTurn:true,rationale:'Original session inspected separately',report:{path:report,sha256:sha(fs.readFileSync(report))}};
 const evidenceFile=path.join(root,'evidence.json');fs.writeFileSync(evidenceFile,JSON.stringify(evidence));
 const evidenceSha256=sha(fs.readFileSync(evidenceFile));
 const approvalFile=path.join(root,'approval.json');fs.writeFileSync(approvalFile,JSON.stringify({...shared,version:1,decision:'authorize_saved_turn_and_pipeline',humanAuthorized:true,approvedBy:'human',approvedAt:new Date().toISOString(),evidenceSha256}));
 return {eventId:event.id,humanAuthorized:true as const,approvalFile,approvalSha256:sha(fs.readFileSync(approvalFile)),evidenceFile,evidenceSha256};
}
function hint(task:Task){return {event:'model_step_observed_unverified',sessionId:task.pendingAgentTurn!.sessionId,stepIndex:3,rowSha256:'a'.repeat(64),source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE'};}
describe('actual ProjectEngine/TaskEngine P2-B entry, offline',()=>{
 it('actual entry yields without initializing providers, restart keeps binding',async()=>{
  const {engine,task,bridge,initialize,options}=await setup();
  expect((await engine.runTask(task.id)).status).toBe('REVIEW');expect(initialize).not.toHaveBeenCalled();
  const current=(await engine.getTask(task.id));const event=bridge.ingest(current,hint(task));
  const restarted=new TaskEngine(options);await restarted.recoverPendingTasks();
  await vi.waitFor(()=>expect((restarted as any).dispatches.size).toBe(0));
  expect(bridge.ingest(await restarted.getTask(task.id),hint(task)).id).toBe(event.id);
  expect(initialize).not.toHaveBeenCalled();
 });
 it('real entry checks human records and independent report before runner continuation; duplicate restart denied',async()=>{
  const {engine,task,bridge,root,options}=await setup();bridge.bind(task);const event=bridge.ingest(task,hint(task));const req=approve(root,task,event);
  // Only the model-executing pipeline is replaced; public engine, file verifier, locks and bridge are real.
  const run=vi.spyOn(TaskRunner.prototype,'run').mockImplementation(async function(this:TaskRunner){return this.getTask();});
  await engine.resumeTranscriptEvent(task.id,req);expect(run).toHaveBeenCalledTimes(1);
  await expect(new TaskEngine(options).resumeTranscriptEvent(task.id,req)).rejects.toThrow('ALREADY_CLAIMED');
  expect(run).toHaveBeenCalledTimes(1);expect(bridge.ingest(task,hint(task)).state).toBe('consumed');
 });
 it('actual runner restores only original pending turn and follows NEED_USER output, not hint DONE',async()=>{
  const {engine,task,bridge,root,options}=await setup();
  task.testCommand='node -e "process.exit(0)"';await engine.getStore().saveTask(task);
  bridge.bind(task);const event=bridge.ingest(task,hint(task));const req=approve(root,task,event);
  const restore=vi.fn(async()=>task.pendingAgentTurn!.sessionId),wait=vi.fn(async()=>({text:'AGENT_STATUS: NEED_USER\nNeed human input'})),prompt=vi.fn();
  const agent={initialize:vi.fn(async()=>{}),createSession:vi.fn(async()=>'synthetic-other'),restorePendingTurn:restore,waitForPendingTurn:wait,prompt};
  vi.spyOn(GitService,'getDiff').mockResolvedValue('synthetic diff');
  const actual=new TaskEngine({...options,codexAgent:agent as any,geminiAgent:agent as any});
  const result=await actual.resumeTranscriptEvent(task.id,req);
  expect(result.status).toBe('NEED_USER');expect(wait).toHaveBeenCalledTimes(1);expect(restore).toHaveBeenCalledWith(task.pendingAgentTurn);expect(prompt).not.toHaveBeenCalled();
 });
 it('DONE hint alone and missing human authorization cannot invoke pipeline',async()=>{
  const {engine,task,bridge,initialize}=await setup();bridge.bind(task);const event=bridge.ingest(task,hint(task));
  await expect(engine.resumeTranscriptEvent(task.id,{eventId:event.id} as any)).rejects.toThrow('AUTHORIZATION');
  await expect(engine.resumeTranscriptEvent(task.id,{eventId:event.id,humanAuthorized:true} as any)).rejects.toThrow();
  expect(initialize).not.toHaveBeenCalled();expect(bridge.ingest(task,hint(task)).state).toBe('pending_verification');
 });
 it.each(['report','evidence','approval','binding','revision','decision'])('rejects changed or unapproved %s',async what=>{
  const {engine,task,bridge,root,initialize}=await setup();bridge.bind(task);const event=bridge.ingest(task,hint(task));const req=approve(root,task,event);
  if(what==='report')fs.appendFileSync(path.join(root,'independent-review.txt'),'tamper');
  else if(what==='evidence')fs.appendFileSync(req.evidenceFile,' ');
  else if(what==='approval')fs.appendFileSync(req.approvalFile,' ');
  else {const a=JSON.parse(fs.readFileSync(req.approvalFile,'utf8'));if(what==='binding')a.binding.startStepIndex=7;else if(what==='revision')a.taskRevision++;else a.decision='DONE';fs.writeFileSync(req.approvalFile,JSON.stringify(a));req.approvalSha256=sha(fs.readFileSync(req.approvalFile));}
  await expect(engine.resumeTranscriptEvent(task.id,req)).rejects.toThrow();expect(initialize).not.toHaveBeenCalled();
 });
 it('shares existing execution lock across engine instances without claiming the event',async()=>{
  const {engine,task,bridge,root,options}=await setup();bridge.bind(task);const event=bridge.ingest(task,hint(task));const req=approve(root,task,event);
  await engine.getStore().runTaskExecutionExclusive(task.id,async()=>{
   await expect(new TaskEngine(options).resumeTranscriptEvent(task.id,req)).rejects.toMatchObject({code:'TASK_EXECUTION_BUSY'});
  });expect(bridge.ingest(task,hint(task)).state).toBe('pending_verification');
 });
 it('new turn is preserved and blocked without deleting prior state',async()=>{
  const {engine,task,bridge,root,initialize}=await setup();bridge.bind(task);bridge.ingest(task,hint(task));
  const file=path.join(root,'data/gemini-event-bridge',fs.readdirSync(path.join(root,'data/gemini-event-bridge'))[0]);const before=fs.readFileSync(file,'utf8');
  task.pendingAgentTurn!.startStepIndex=8;await engine.getStore().saveTask(task);
  const result=await engine.runTask(task.id);expect(result.status).toBe('REVIEW');expect(result.pendingAgentTurn!.startStepIndex).toBe(8);
  expect(result.nextAction).toContain('REBIND_REQUIRES_HUMAN_RECONCILIATION');expect(fs.readFileSync(file,'utf8')).toBe(before);expect(initialize).not.toHaveBeenCalled();
 });
 it('explicit false preserves legacy runner entry even when environment enables bridge',async()=>{
  vi.stubEnv('AGENTHUB_TRANSCRIPT_BRIDGE','1');const {engine,task}=await setup(false);
  const run=vi.spyOn(TaskRunner.prototype,'run').mockImplementation(async function(this:TaskRunner){expect((this as any).transcriptBridge).toBeUndefined();return this.getTask();});
  await engine.runTask(task.id);expect(run).toHaveBeenCalledTimes(1);
 });
 it('environment enables actual default engine and requires an absolute explicit brain root',async()=>{
  const {root}=await setup();vi.stubEnv('AGENTHUB_STORE',root);vi.stubEnv('AGENTHUB_TRANSCRIPT_BRIDGE','1');vi.stubEnv('AGENTHUB_GEMINI_BRAIN_ROOT',root);
  const engine=new ProjectEngine();expect(engine.getStore().getBaseDirectory()).toBe(root);expect((engine as any).transcriptBridge).toBeDefined();
  vi.stubEnv('AGENTHUB_GEMINI_BRAIN_ROOT','relative');expect(()=>new ProjectEngine()).toThrow('EXPLICIT_GEMINI_BRAIN_ROOT_REQUIRED');
 });
});
