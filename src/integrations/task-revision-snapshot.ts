import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OrcaEvidenceStore} from './orca-evidence.js';

/** Capture observed bytes, never reconstruct an absent historical revision.
 * Caller holds task-writes. BEFORE/AFTER are observations, not transaction IDs.
 * If AFTER fails the task may already be committed; do not retry the write.
 */
export async function retainTaskRevisionSnapshot(root:string, taskId:string, bytes:Buffer,
  phase:'BEFORE_WRITE'|'AFTER_WRITE') {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(taskId)||!['BEFORE_WRITE','AFTER_WRITE'].includes(phase))
    throw Error('INVALID_TASK_REVISION_SNAPSHOT');
  root=await fs.realpath(root); // normal macOS /var temporary-root alias; descendants remain fenced
  const parsed=JSON.parse(bytes.toString('utf8'));
  const revision=parsed?.revision??0;
  if(parsed?.id!==taskId||!Number.isSafeInteger(revision)||revision<0)
    throw Error('INVALID_TASK_REVISION_SNAPSHOT');
  const ref=await new OrcaEvidenceStore(root).put(bytes);
  const directory=path.join(root,'data/task-revision-snapshots',taskId);
  for(const p of [path.join(root,'data'),path.join(root,'data/task-revision-snapshots'),directory]) {
    await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(p)!==p)
      throw Error('INVALID_TASK_REVISION_SNAPSHOT_ROOT');
  }
  const record={version:1,taskId,revision,phase,evidence:ref,
    scope:'OBSERVED_TASK_BYTES',sourceAuthenticated:false};
  const target=path.join(directory,`${revision}-${ref.sha256}-${phase}.json`),data=JSON.stringify(record);
  const temporary=path.join(directory,'.'+randomUUID()+'.tmp');
  try {
    const fd=await fs.open(temporary,'wx',0o600);
    try{await fd.writeFile(data);await fd.sync();}finally{await fd.close();}
    try{await fs.link(temporary,target);}catch(e:any){if(e.code!=='EEXIST')throw e;}
  }finally{await fs.unlink(temporary).catch(()=>{});}
  const s=await fs.lstat(target);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||await fs.readFile(target,'utf8')!==data)
    throw Error('TASK_REVISION_SNAPSHOT_CONFLICT');
  const dir=await fs.open(directory,'r');try{await dir.sync();}finally{await dir.close();}
  return record;
}
