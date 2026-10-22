import {describe,it,expect,afterEach,vi} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {GeminiTaskEventBridge,bindingFor} from '../../src/integrations/gemini-task-event-bridge.js';
import {TaskRunner} from '../../src/tasks/task-runner.js';
import {AgentTurnPendingError} from '../../src/agents/agent.js';
import type {Task} from '../../src/tasks/task.js';
const roots:string[]=[];
afterEach(()=>{for(const d of roots.splice(0)) fs.rmSync(d,{recursive:true,force:true});});
const sessionId='12345678-1234-1234-1234-123456789abc';
function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p2b-'));roots.push(dir);
 const task={id:'T1',status:'REVIEW',reviewerId:'gemini',ownerId:'gemini',pendingAgentTurn:{sessionId,startStepIndex:2,requestTime:'2026-10-17T10:00:00Z',actor:'gemini',phase:'REVIEW'}} as Task;
 const bridge=new GeminiTaskEventBridge(dir);bridge.bind(task);
 const hint={event:'model_step_observed_unverified',sessionId,stepIndex:3,rowSha256:'a'.repeat(64),source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE'};
 const store={getTask:vi.fn(async()=>structuredClone(task))};
 const auth={humanAuthorized:true as const,evidence:'explicit human approval reference'};
 return {dir,task,bridge,hint,store,auth};
}
describe('P2-B offline',()=>{
 it('public runner recovery requires verification and consumes the event once',async()=>{
  const {bridge,task,hint,store,auth}=setup();const event=bridge.ingest(task,hint);
  const runner=new TaskRunner({task,store:store as any,transcriptBridge:bridge,codexAgent:{} as any,geminiAgent:{} as any});
  const run=vi.spyOn(runner,'run').mockImplementation(async()=>{
    expect((runner as any).bridgeResumeInProgress).toBe(true);
    expect(runner.getTask().pendingAgentTurn).toEqual(task.pendingAgentTurn);
    return runner.getTask();
  });
  const verify=vi.fn(async()=>true);
  await runner.resumeTranscriptEvent(event.id,auth,verify);
  expect(verify).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledTimes(1);
  expect((runner as any).bridgeResumeInProgress).toBe(false);
  await expect(runner.resumeTranscriptEvent(event.id,auth,verify)).rejects.toThrow('ALREADY_CLAIMED');
  expect(run).toHaveBeenCalledTimes(1);
 });
 it('watch rejects checkpoint drift instead of queuing into a new turn',async()=>{
  const {bridge,task,dir,store}=setup();const root=path.join(dir,'brain'),logs=path.join(root,sessionId,'.system_generated','logs');fs.mkdirSync(logs,{recursive:true});
  fs.writeFileSync(path.join(logs,'transcript.jsonl'),[2,3].map(step_index=>JSON.stringify({step_index,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE'})).join('\n')+'\n');
  store.getTask.mockImplementationOnce(async()=>structuredClone(task)).mockImplementationOnce(async()=>({...task,pendingAgentTurn:{...task.pendingAgentTurn!,startStepIndex:8}}));
  await expect(bridge.watch(store,task.id,{root,intervalMs:100,timeoutMs:1000})).rejects.toThrow('TASK_CHANGED_DURING_WATCH');
 });

 it('persists unverified hints with exact binding; restart deduplicates',()=>{
  const {dir,task,bridge,hint}=setup();const e=bridge.ingest(task,hint);
  expect(e).toMatchObject({state:'pending_verification',binding:bindingFor(task),sourceAuthenticated:false,canCompleteTask:false,approvalIssued:false});
  expect(new GeminiTaskEventBridge(dir).ingest(task,hint)).toEqual(e);expect(task.status).toBe('REVIEW');
  expect(()=>bridge.ingest(task,{...hint,rowSha256:'b'.repeat(64)})).toThrow('CONFLICT');
 });
 it.each([{sessionId:'wrong'},{stepIndex:2},{rowSha256:'bad'},{type:'OTHER'},{status:'WAITING'}])('rejects bad hint %j',delta=>{
  const {bridge,task,hint}=setup();expect(()=>bridge.ingest(task,{...hint,...delta})).toThrow('INVALID_TRANSCRIPT_HINT');
 });
 it('rejects rebinding and human waiting',()=>{
  const {bridge,task}=setup();expect(()=>bridge.bind({...task,pendingAgentTurn:{...task.pendingAgentTurn!,startStepIndex:9}})).toThrow('REBIND');
  expect(()=>bridge.bind({...task,status:'NEED_USER'})).toThrow('REQUIRES_HUMAN');
  expect(()=>bridge.bind({...task,pendingHumanResponse:'approve'})).toThrow('REQUIRES_HUMAN');
 });
 it('requires explicit human authorization before callbacks',async()=>{
  const {bridge,task,hint,store}=setup();const e=bridge.ingest(task,hint);const verify=vi.fn(),resume=vi.fn();
  await expect(bridge.resume(store,task.id,e.id,{} as any,verify,resume)).rejects.toThrow('AUTHORIZATION');
  expect(verify).not.toHaveBeenCalled();expect(resume).not.toHaveBeenCalled();
 });
 it('reserves whole turn across events, concurrency and restart',async()=>{
  const {bridge,task,hint,store,auth,dir}=setup();const e=bridge.ingest(task,hint),e2=bridge.ingest(task,{...hint,stepIndex:4});
  let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});const resume=vi.fn(async()=>{});
  const first=bridge.resume(store,task.id,e.id,auth,async()=>{await wait;return true;},resume);
  await vi.waitFor(()=>expect(store.getTask).toHaveBeenCalled());
  await expect(new GeminiTaskEventBridge(dir).resume(store,task.id,e2.id,auth,async()=>true,resume)).rejects.toThrow('ALREADY_CLAIMED');
  release();await first;
  await expect(new GeminiTaskEventBridge(dir).resume(store,task.id,e.id,auth,async()=>true,resume)).rejects.toThrow('ALREADY_CLAIMED');
  expect(resume).toHaveBeenCalledTimes(1);
 });
 it('verification failure blocks dispatch and leaves human review state',async()=>{
  const {bridge,task,hint,store,auth,dir}=setup();const e=bridge.ingest(task,hint),resume=vi.fn();
  await expect(bridge.resume(store,task.id,e.id,auth,async()=>false,resume)).rejects.toThrow('VERIFICATION');
  expect(resume).not.toHaveBeenCalled();expect(new GeminiTaskEventBridge(dir).ingest(task,hint).state).toBe('needs_human_review');
 });
 it('checks checkpoint again after asynchronous verification',async()=>{
  const {bridge,task,hint,store,auth}=setup();const e=bridge.ingest(task,hint),resume=vi.fn();
  await expect(bridge.resume(store,task.id,e.id,auth,async()=>{task.pendingAgentTurn!.startStepIndex=9;return true;},resume)).rejects.toThrow('TASK_CHANGED');
  expect(resume).not.toHaveBeenCalled();
 });
 it('ambiguous callback outcome cannot be retried',async()=>{
  const {bridge,task,hint,store,auth}=setup();const e=bridge.ingest(task,hint);const resume=vi.fn(async()=>{throw Error('unknown outcome');});
  await expect(bridge.resume(store,task.id,e.id,auth,async()=>true,resume)).rejects.toThrow('unknown outcome');
  await expect(bridge.resume(store,task.id,e.id,auth,async()=>true,resume)).rejects.toThrow('ALREADY_CLAIMED');expect(resume).toHaveBeenCalledTimes(1);
 });
 it('fails closed on leftover crash lock and corrupt state',()=>{
  const {bridge,task,dir}=setup();const f=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.json'))!);const lock=f.replace('.json','.lock');
  fs.writeFileSync(lock,'');expect(()=>bridge.bind(task)).toThrow();fs.unlinkSync(lock);fs.writeFileSync(f,'broken');expect(()=>bridge.bind(task)).toThrow();
 });
 it('watches synthetic log locally and queues only metadata',async()=>{
  const {bridge,task,dir,store}=setup();const root=path.join(dir,'brain'),logs=path.join(root,sessionId,'.system_generated','logs');fs.mkdirSync(logs,{recursive:true});
  fs.writeFileSync(path.join(logs,'transcript.jsonl'),[2,3].map(step_index=>JSON.stringify({step_index,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE'})).join('\n')+'\n');
  expect(await bridge.watch(store,task.id,{root,intervalMs:100,timeoutMs:1000})).toMatchObject({state:'pending_verification',stepIndex:3});
 });
 it('runner with pending checkpoint yields before initializing agents',async()=>{
  const {bridge,task,store}=setup();const initialize=vi.fn();const runner=new TaskRunner({task,store:store as any,transcriptBridge:bridge,codexAgent:{initialize} as any,geminiAgent:{initialize} as any});
  expect((await runner.run()).status).toBe('REVIEW');expect(initialize).not.toHaveBeenCalled();
 });
 it('runner yields first timeout without resending or NEED_USER transition',async()=>{
  const {bridge,task,store}=setup();const saveTask=vi.fn(async()=>{});const runner=new TaskRunner({task,store:{...store,saveTask} as any,transcriptBridge:bridge,codexAgent:{} as any,geminiAgent:{} as any});
  const wait=vi.fn(async()=>{throw new AgentTurnPendingError(task.pendingAgentTurn!);}),prompt=vi.fn();
  await expect((runner as any).promptWithRecovery({waitForPendingTurn:wait,prompt},sessionId,'unused','gemini','REVIEW')).rejects.toThrow();
  expect(wait).toHaveBeenCalledTimes(1);expect(prompt).not.toHaveBeenCalled();expect(runner.getTask().status).toBe('REVIEW');expect(saveTask).toHaveBeenCalledTimes(1);
 });
});
