#!/usr/bin/env node
/** Offline only: fresh temporary Git/store, mock agents and injected Orca reads.
 * Does not invoke Orca, agentapi, a model, or a real approval channel.
 * Retains all synthetic evidence; stdout names the newly allocated directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectEngine} from '../dist/projects/project-engine.js';
import {AgentTurnPendingError} from '../dist/agents/agent.js';
import {GeminiTaskEventBridge, bindingFor} from '../dist/integrations/gemini-task-event-bridge.js';
import {persistOrcaBindingWithBaseline} from '../dist/integrations/orca-binding.js';
import {watchTerminal, readOrcaTerminal, sha256} from './orca-terminal-watch.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2b-architecture-synthetic-'));
const repo=path.join(root,'workspace'),storeRoot=path.join(root,'agenthub-store'),brain=path.join(root,'brain');
fs.mkdirSync(repo);fs.mkdirSync(brain);
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:os.devNull,GIT_CONFIG_NOSYSTEM:'1'}});
git('init','--initial-branch=synthetic-main');fs.writeFileSync(path.join(repo,'README.md'),'Synthetic repository only\n');
git('add','README.md');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','-m','Synthetic baseline');
const hash=x=>createHash('sha256').update(x).digest('hex');
const checks=[];
function checked(name){checks.push(name);}
const calls={prompt:0,wait:0,restore:0};
let handler, engine;
const checkpoint={sessionId:'12345678-1234-1234-1234-123456789abc',startStepIndex:2,requestTime:new Date().toISOString()};
const common={initialize:async()=>{},close:async()=>{},cancel:async()=>{}};
const gemini={...common,name:'gemini',createSession:async()=>checkpoint.sessionId,
 setPendingTurnHandler:h=>{handler=h;},
 prompt:async(session)=>{
  calls.prompt++;assert.equal(session,checkpoint.sessionId);
  // Same persist-before-send contract as AntigravityAgent.prompt; no send occurs.
  await handler(checkpoint);
  assert.deepEqual((await engine.getTask('SYNTHETIC-INTERNAL')).pendingAgentTurn,{...checkpoint,actor:'gemini',phase:'DOING'});
  checked('checkpoint persisted by runner callback before simulated send');
  throw new AgentTurnPendingError(checkpoint);
 },
 restorePendingTurn:async p=>{calls.restore++;assert.equal(p.sessionId,checkpoint.sessionId);return p.sessionId;},
 waitForPendingTurn:async p=>{calls.wait++;assert.equal(p.startStepIndex,2);return {text:'AGENT_STATUS: NEED_USER\nSynthetic human decision required.'};}
};
const codex={...common,name:'codex',createSession:async()=>'synthetic-reviewer',prompt:async()=>{throw Error('Unexpected reviewer prompt');}};
const options={baseDir:storeRoot,transcriptBridgeEnabled:true,transcriptBrainRoot:brain,codexAgent:codex,geminiAgent:gemini};
engine=new ProjectEngine(options);
await engine.createProject({id:'SYNTHETIC-P',name:'Synthetic only',description:'Offline architecture rehearsal',workspace:repo});
const created=await engine.createTask({id:'SYNTHETIC-INTERNAL',projectId:'SYNTHETIC-P',title:'synthetic internal',description:'No real model',workspace:repo,ownerId:'gemini',reviewerId:'codex',testCommand:'node -e "process.exit(0)"'});
assert.equal(created.status,'TODO');assert.equal(created.pendingAgentTurn,undefined);checked('new task starts without checkpoint');
let pending=await engine.runTask(created.id);
assert.equal(pending.status,'DOING');assert.equal(calls.prompt,1);assert.ok(pending.pendingAgentTurn);assert.equal(calls.wait,0);
checked('first actual engine/runner execution creates worktree and yields on pending turn');
const cli=fileURLToPath(new URL('./gemini-task-event-bridge.mjs',import.meta.url));
const flags=['--task',created.id,'--store',storeRoot,'--brain-root',brain];
const cliRun=(mode,extra=[])=>JSON.parse(execFileSync(process.execPath,[cli,mode,...flags,...extra],{encoding:'utf8'}));
const inspect=cliRun('inspect');assert.deepEqual(inspect.binding,bindingFor(pending));
const logs=path.join(brain,checkpoint.sessionId,'.system_generated/logs');fs.mkdirSync(logs,{recursive:true});
fs.writeFileSync(path.join(logs,'transcript.jsonl'),JSON.stringify({step_index:3,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE'})+'\n');
const taskFile=path.join(storeRoot,'data/tasks',created.id+'.json'),beforeWatch=fs.readFileSync(taskFile);
const event=cliRun('watch'),duplicate=cliRun('watch');
assert.equal(event.id,duplicate.id);assert.equal(event.state,'pending_verification');assert.deepEqual(fs.readFileSync(taskFile),beforeWatch);
checked('separate CLI processes inspect/watch/deduplicate without task mutation');
await assert.rejects(engine.resumeTranscriptEvent(created.id,{eventId:event.id}),/AUTHORIZATION/);
assert.equal(calls.wait,0);checked('DONE observation alone cannot resume');
// Deliberately synthetic files, never represented as real human approval.
const report=path.join(root,'SYNTHETIC-independent-review.txt');fs.writeFileSync(report,'SYNTHETIC ONLY: fixture reviewer checks exact original turn, not a real human attestation.');
const shared={version:1,taskId:created.id,taskRevision:pending.revision,eventId:event.id,binding:bindingFor(pending)};
const evidenceFile=path.join(root,'SYNTHETIC-evidence.json');
fs.writeFileSync(evidenceFile,JSON.stringify({...shared,kind:'independent_original_turn_review',reviewedBy:'synthetic-operator',reviewedAt:new Date().toISOString(),originalSessionIdentityChecked:true,fullTurnResponseChecked:true,safeToRestoreSavedTurn:true,rationale:'Offline fixture only',report:{path:report,sha256:hash(fs.readFileSync(report))}}));
const evidenceSha256=hash(fs.readFileSync(evidenceFile)),approvalFile=path.join(root,'SYNTHETIC-approval.json');
fs.writeFileSync(approvalFile,JSON.stringify({...shared,decision:'authorize_saved_turn_and_pipeline',humanAuthorized:true,approvedBy:'synthetic-human-fixture',approvedAt:new Date().toISOString(),evidenceSha256}));
const request={eventId:event.id,humanAuthorized:true,approvalFile,approvalSha256:hash(fs.readFileSync(approvalFile)),evidenceFile,evidenceSha256};
const restarted=new ProjectEngine(options);
await engine.getStore().runTaskExecutionExclusive(created.id,async()=>{
 await assert.rejects(restarted.resumeTranscriptEvent(created.id,request),e=>e.code==='TASK_EXECUTION_BUSY');
});checked('restarted engine cannot recover while original execution lock held');
const recovered=await restarted.resumeTranscriptEvent(created.id,request);
assert.equal(recovered.status,'NEED_USER');assert.equal(calls.prompt,1);assert.equal(calls.wait,1);assert.equal(calls.restore,1);
assert.equal(recovered.pendingAgentTurn,undefined);
const state=JSON.parse(fs.readFileSync(path.join(storeRoot,'data/gemini-event-bridge',hash(JSON.stringify(created.id))+'.json'),'utf8'));
assert.equal(state.events.find(e=>e.id===event.id).state,'consumed');
// Real runner cleared the completed checkpoint: repeat fails before any restore.
await assert.rejects(new ProjectEngine(options).resumeTranscriptEvent(created.id,request),/INVALID_PENDING_BINDING/);
assert.equal(calls.wait,1);assert.equal(calls.prompt,1);
checked('pinned synthetic review restores original turn once through real runner; NEED_USER not DONE');

// Orca path: real local binding/baseline and locks, simulated terminal transport.
const external=await engine.createTask({id:'SYNTHETIC-ORCA',projectId:'SYNTHETIC-P',title:'synthetic Orca',description:'Not a live dispatch',workspace:repo,ownerId:'gemini',reviewerId:'codex'});
external.status='DOING';await engine.getStore().saveTask(external);
const binding={agenthubTaskId:external.id,projectId:external.projectId,revision:String(external.revision+1),generation:1,runtimeId:'synthetic-runtime',hostId:'synthetic-host',runId:'synthetic-run',taskId:'synthetic-orca-task',dispatchId:'synthetic-dispatch',workspaceId:'synthetic-workspace',workspacePath:repo,terminalHandle:'term_00000000-0000-0000-0000-000000000001',developer:'gemini',reviewer:'codex',provider:'antigravity',ownerId:'gemini',claimId:null};
await persistOrcaBindingWithBaseline(engine.getStore(),binding,['README.md']);
const externalFile=path.join(storeRoot,'data/tasks',external.id+'.json'),externalBytes=fs.readFileSync(externalFile);
const bound=await engine.getTask(external.id);assert.ok(bound.orcaBaseline);assert.equal(bound.pendingAgentTurn,undefined);
await assert.rejects(restarted.runTask(external.id),/Orca-bound/);
await assert.rejects(restarted.resumeTranscriptEvent(external.id,request),/Orca-bound/);
const bridge=new GeminiTaskEventBridge(path.join(storeRoot,'data/gemini-event-bridge'));
// Even an accidentally injected internal checkpoint cannot bypass component guard.
const invalidMixed={...bound,pendingAgentTurn:pending.pendingAgentTurn};
const bridgeFilesBefore=fs.readdirSync(path.join(storeRoot,'data/gemini-event-bridge')).sort();
const internalStateBefore=fs.readFileSync(path.join(storeRoot,'data/gemini-event-bridge',hash(JSON.stringify(created.id))+'.json'));
assert.throws(()=>bridge.bind(invalidMixed),/ORCA_BOUND/);
assert.throws(()=>bridge.ingest(invalidMixed,{}),/ORCA_BOUND/);
await assert.rejects(bridge.watch({getTask:async()=>invalidMixed},external.id,{root:brain,intervalMs:1000,timeoutMs:1000}),/ORCA_BOUND/);
await assert.rejects(bridge.resume({getTask:async()=>invalidMixed},external.id,event.id,{humanAuthorized:true,evidence:'synthetic'},async()=>{throw Error('Verifier must not execute');},async()=>{throw Error('Resume must not execute');}),/ORCA_BOUND/);
assert.deepEqual(fs.readdirSync(path.join(storeRoot,'data/gemini-event-bridge')).sort(),bridgeFilesBefore);
assert.deepEqual(fs.readFileSync(path.join(storeRoot,'data/gemini-event-bridge',hash(JSON.stringify(created.id))+'.json')),internalStateBefore);
await engine.getStore().runTaskExecutionExclusive(external.id,async()=>{
 await assert.rejects(new ProjectEngine(options).runTask(external.id),e=>e.code==='TASK_EXECUTION_BUSY');
});checked('Orca ownership/baseline and execution locks retained; internal dispatch/recovery/component binding refused');
const reads=[];let tick=0,readCount=0;
const fakeRun=(exe,args,settings,cb)=>{
 assert.equal(exe,'orca');assert.deepEqual(args,['terminal','read','--terminal',binding.terminalHandle,'--limit','80','--json']);assert.equal(settings.shell,false);
 reads.push(args);cb(null,JSON.stringify({ok:true,result:{output:readCount++===0?'working':'1. Approve? Synthetic completion text'}}));
};
const notification=await watchTerminal({field:'result.output',timeoutMs:10000,intervalMs:1000},{read:()=>readOrcaTerminal({terminal:binding.terminalHandle,limit:80,run:fakeRun}),clock:()=>tick,sleep:async ms=>{tick+=ms;}});
assert.equal(notification.event,'terminal_content_changed_unverified');
assert.equal(notification.approvalIssued,false);assert.equal(notification.canCompleteTask,false);
assert.equal(notification.observedSha256,sha256('1. Approve? Synthetic completion text'));
assert.deepEqual(fs.readFileSync(externalFile),externalBytes);
assert.equal(reads.length,2);assert.equal(calls.prompt,1);
checked('Orca exact-terminal observation notifies only; no send, approval, resume or task write');
const result={ok:true,scope:'OFFLINE_SYNTHETIC_ONLY',root,checks,calls,internal:{taskId:created.id,firstStatus:pending.status,finalStatus:recovered.status,eventId:event.id},orca:{taskId:external.id,status:bound.status,binding:bound.orcaBinding,taskSha256:hash(externalBytes),taskUnchanged:true,notification,transport:'INJECTED_FAKE_READ_ONLY'},realModelsCalled:false,realOrcaCalled:false,realHumanApprovalVerified:false,productionAccepted:false};
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:true,checks:checks.length,report:path.join(root,'result.json')}));
