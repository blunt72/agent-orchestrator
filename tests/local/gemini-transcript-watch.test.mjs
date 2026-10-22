import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, unlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, parseChunk, observe, TranscriptWatchError } from '../../scripts/gemini-transcript-watch.mjs';

const session = 'aaaaaaaa-0000-4000-8000-000000000008';
const row = (i, source='MODEL', type='PLANNER_RESPONSE', status='DONE') => JSON.stringify({step_index:i,source,type,status,content:'PRIVATE-SHOULD-NOT-LEAK'})+'\n';
async function fixture(lines = row(1)) {
  const root = await mkdtemp(join(tmpdir(), 'gemini-watch-'));
  const dir = join(root, session, '.system_generated', 'logs');
  await mkdir(dir, { recursive:true });
  const file = join(dir,'transcript.jsonl');
  await writeFile(file, lines);
  const opts = { mode:'watch', session, root, intervalMs:100, timeoutMs:1300 };
  return { root, file, opts, cleanup: () => rm(root,{recursive:true,force:true}) };
}

test('validates selected session and rejects unknown options', () => {
  const args = parseArgs(['watch','--session',session]);
  assert.equal(args.session,session);
  assert.match(args.root, /antigravity-cli\/brain$/);
  assert.throws(() => parseArgs(['watch','--session','../../bad']), /INVALID_SESSION/);
  assert.throws(() => parseArgs(['watch','--session',session,'--send','1']), /INVALID_OPTIONS/);
});

test('parses complete lines and retains partial JSON without emitting content', () => {
  const b = Buffer.from(row(1)+row(2).slice(0,-2));
  const first = parseChunk(b);
  assert.equal(first.rows.length,1);
  assert.equal(first.rows[0].stepIndex,1);
  const second = parseChunk(Buffer.from(row(2).slice(-2)),first.carry);
  assert.equal(second.rows[0].stepIndex,2);
  assert.equal(JSON.stringify(second).includes('PRIVATE'),false);
});

test('inspect only returns safe metadata', async () => {
  const f = await fixture(row(1)+row(2,'USER_EXPLICIT','USER_INPUT'));
  try {
    const result = await observe({...f.opts,mode:'inspect'});
    assert.equal(result.rows,2);
    assert.equal(result.lastStepIndex,2);
    assert.equal(result.canCompleteTask,false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  } finally { await f.cleanup(); }
});

test('replays exactly one later matching observation with explicit cursor', async () => {
  const f = await fixture(row(1)+row(2,'MODEL','GENERIC')+row(3));
  try {
    const result = await observe({...f.opts,afterStep:1});
    assert.equal(result.stepIndex,3);
    assert.equal(result.event,'model_step_observed_unverified');
    assert.equal(result.approvalIssued,false);
    assert.equal(result.turnCompletionVerified,false);
    assert.equal(result.sourceAuthenticated,false);
  } finally { await f.cleanup(); }
});

test('default watch does not replay old entries, but captures appended row', async () => {
  const f = await fixture(row(1)+row(2));
  try {
    setTimeout(() => { appendFile(f.file,row(3)).catch(()=>{}); },220);
    const result = await observe(f.opts);
    assert.equal(result.stepIndex,3);
    assert.equal(result.canCompleteTask,false);
  } finally { await f.cleanup(); }
});

test('ignores nonmatching new events and waits for model planner response', async () => {
  const f = await fixture(row(1));
  try {
    setTimeout(() => { appendFile(f.file,row(2,'MODEL','GENERIC')+row(3,'USER_EXPLICIT','USER_INPUT')).catch(()=>{}); },140);
    setTimeout(() => { appendFile(f.file,row(4)).catch(()=>{}); },330);
    const result = await observe(f.opts);
    assert.equal(result.stepIndex,4);
  } finally { await f.cleanup(); }
});

test('does not misinterpret partial JSON row as completed event', async () => {
  const f = await fixture(row(1));
  try {
    const next = row(2);
    setTimeout(() => { appendFile(f.file,next.slice(0,10)).catch(()=>{}); },130);
    setTimeout(() => { appendFile(f.file,next.slice(10)).catch(()=>{}); },280);
    const result = await observe(f.opts);
    assert.equal(result.stepIndex,2);
  } finally { await f.cleanup(); }
});

test('detects transcript truncation or replacement instead of silently restarting', async () => {
  const f = await fixture(row(1)+row(2)+row(3));
  try {
    setTimeout(() => { writeFile(f.file,row(0)).catch(()=>{}); },130);
    await assert.rejects(observe(f.opts), /TRANSCRIPT_REPLACED_OR_TRUNCATED/);
  } finally { await f.cleanup(); }
});

test('rejects missing fields, duplicate index and malformed rows', async () => {
  const f = await fixture(row(1)+row(1));
  try {
    await assert.rejects(observe({...f.opts,mode:'inspect'}), /TRANSCRIPT_STEP_REORDERED/);
    await writeFile(f.file,'{"step_index":1,"source":"MODEL"}\n');
    await assert.rejects(observe({...f.opts,mode:'inspect'}), /TRANSCRIPT_ROW_INVALID/);
  } finally { await f.cleanup(); }
});

test('reports timeout with no model usage / writes / approvals', async () => {
  const f = await fixture(row(1));
  try {
    const result = await observe({...f.opts,timeoutMs:1000,intervalMs:100});
    assert.equal(result.event,'timeout_no_new_matching_step');
    assert.equal(result.approvalIssued,false);
    assert.equal(result.canCompleteTask,false);
  } finally { await f.cleanup(); }
});

test('supports cancellation and fails closed on missing file', async () => {
  const f = await fixture(row(1));
  try {
    const ctrl = new AbortController();
    setTimeout(()=>ctrl.abort(),200);
    await assert.rejects(observe(f.opts,{signal:ctrl.signal}), /WATCH_CANCELLED/);
    await unlink(f.file);
    await assert.rejects(observe(f.opts), /TRANSCRIPT_NOT_FOUND/);
  } finally { await f.cleanup(); }
});

test('streams multi-megabyte baseline rather than failing at 4MB', async () => {
  const huge = Array.from({length: 26000}, (_, i) =>
    JSON.stringify({step_index:i,source:'MODEL',type:'GENERIC',status:'DONE',content:'x'.repeat(160)})+'\n'
  ).join('');
  assert.ok(Buffer.byteLength(huge) > 4*1024*1024);
  const f = await fixture(huge);
  try {
    const info = await observe({...f.opts,mode:'inspect'});
    assert.equal(info.rows,26000);
    assert.equal(info.lastStepIndex,25999);
  } finally { await f.cleanup(); }
});
