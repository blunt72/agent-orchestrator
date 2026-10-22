#!/usr/bin/env node
/** Explicit task binding only. watch/inspect never instantiate an agent or runner. */
import {promises as fs, constants} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {GeminiTaskEventBridge, bindingFor} from '../dist/integrations/gemini-task-event-bridge.js';
const options = {};
try {
  const args = process.argv.slice(2), mode = args[0];
  if (!['inspect','watch','resume'].includes(mode)) throw Error('INVALID_MODE');
  const allowed = new Set(['--task','--store','--brain-root','--interval-ms','--timeout-ms',
    '--event','--approval-file','--approval-sha256','--evidence-file','--evidence-sha256','--human-authorized']);
  for (let i=1;i<args.length;i+=2) {
    if (!allowed.has(args[i]) || !args[i+1] || Object.hasOwn(options,args[i])) throw Error('INVALID_OPTIONS');
    options[args[i]]=args[i+1];
  }
  const taskId=options['--task'];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(taskId ?? '')) throw Error('INVALID_TASK_ID');
  for (const key of ['--store','--brain-root'])
    if (!options[key] || !isAbsolute(options[key])) throw Error('ABSOLUTE_PATH_REQUIRED');
  const base=resolve(options['--store']), root=resolve(options['--brain-root']);
  const bridgeDir=join(base,'data/gemini-event-bridge');
  const store = {async getTask(id) {
    if (id !== taskId) throw Error('TASK_ID_MISMATCH');
    const handle = await fs.open(join(base,'data/tasks',id+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const st=await handle.stat();
      if (!st.isFile() || st.size>4*1024*1024) throw Error('UNSAFE_TASK_FILE');
      const task=JSON.parse(await handle.readFile('utf8'));
      if (task.id !== taskId || task.orcaBinding) throw Error('TASK_ID_MISMATCH_OR_ORCA_BOUND');
      return task;
    } finally {await handle.close();}
  }};
  const task=await store.getTask(taskId), binding=bindingFor(task);
  if (mode === 'inspect') {
    console.log(JSON.stringify({taskId,taskRevision:task.revision,status:task.status,binding,store:base,bridgeDir,
      transcript:join(root,binding.sessionId,'.system_generated/logs/transcript.jsonl'),approvalIssued:false,canCompleteTask:false},null,2));
  } else if (mode === 'watch') {
    const controller=new AbortController(), cancel=()=>controller.abort();
    process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
    try {
      const bridge=new GeminiTaskEventBridge(bridgeDir);
      const result=await bridge.watch(store,taskId,{root,
        intervalMs:Number(options['--interval-ms'] ?? 1000),timeoutMs:Number(options['--timeout-ms'] ?? 60000)},controller.signal);
      console.log(JSON.stringify(result));
    } finally {process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
  } else {
    if (options['--human-authorized'] !== 'yes') throw Error('EXPLICIT_HUMAN_AUTHORIZATION_REQUIRED');
    const {ProjectEngine}=await import('../dist/projects/project-engine.js');
    const engine=new ProjectEngine({baseDir:base,transcriptBridgeEnabled:true,transcriptBrainRoot:root});
    const result=await engine.resumeTranscriptEvent(taskId,{eventId:options['--event'],humanAuthorized:true,
      approvalFile:options['--approval-file'],approvalSha256:options['--approval-sha256'],
      evidenceFile:options['--evidence-file'],evidenceSha256:options['--evidence-sha256']});
    console.log(JSON.stringify({taskId:result.id,status:result.status}));
  }
} catch (error) {
  const code=error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'BRIDGE_OPERATION_FAILED';
  console.error(JSON.stringify({ok:false,code,approvalIssued:false,canCompleteTask:false}));
  process.exitCode=code === 'WATCH_CANCELLED' ? 130 : 1;
}
