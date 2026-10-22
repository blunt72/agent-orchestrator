import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { observe, binding, textDigest } from '../scripts/orca-receipt-observer.mjs';

const receipt = { runtimeId: 'synthetic-runtime', workspaceId: 'synthetic-workspace', runId: 'synthetic-run',
  taskId: 'synthetic-task', dispatchId: 'synthetic-dispatch', generation: 1,
  terminal: 'term_00000000-0000-0000-0000-000000000001' };
function setup(t, values = ['working', '1. Approve? DONE']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-observer-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  let now = 0, index = 0;
  const options = { receipt, directory, baselineSha256: textDigest('working'), timeoutMs: 3000, intervalMs: 1000 };
  const transport = { read: async () => ({ kind: 'synthetic_terminal_sample', binding: receipt, text: values[Math.min(index++, values.length - 1)] }),
    clock: () => now, sleep: async ms => { now += ms; } };
  return { directory, options, transport };
}
test('each precise identity component is required and mismatch fails before event creation', async t => {
  for (const key of Object.keys(receipt)) {
    const { directory, options, transport } = setup(t);
    const changed = { ...receipt, [key]: key === 'generation' ? 2 : key === 'terminal' ? 'term_00000000-0000-0000-0000-000000000002' : 'other' };
    await assert.rejects(observe(options, { ...transport, read: async () => ({ kind: 'synthetic_terminal_sample', binding: changed, text: 'DONE' }) }), /IDENTITY_MISMATCH/);
    assert.equal(fs.readdirSync(directory).filter(n => n.endsWith('.event.json')).length, 0);
    const missing = { ...receipt }; delete missing[key];
    assert.throws(() => binding(missing), /EXACT_BINDING/);
  }
});
test('no change times out locally without model wake, message or dispatch', async t => {
  const { options, transport, directory } = setup(t, ['working']);
  const result = await observe(options, transport);
  assert.equal(result.event, 'timeout_no_change');
  assert.equal(result.executionDispatched, false); assert.equal(result.notificationDelivered, false);
  assert.equal(fs.readdirSync(directory).length, 1);
});
test('approval prompt and DONE produce metadata pending review only; restart suppresses duplicate', async t => {
  const { options, transport, directory } = setup(t);
  const first = await observe(options, transport);
  assert.equal(first.event, 'pending_verification');
  const event = JSON.parse(fs.readFileSync(path.join(directory, first.id + '.event.json')));
  assert.equal(event.approvalIssued, false); assert.equal(event.canCompleteTask, false);
  assert.equal(event.requiresHumanReview, true); assert.equal(event.sourceAuthenticated, false);
  assert.equal(JSON.stringify(event).includes('Approve?'), false);
  const second = await observe(options, transport);
  assert.equal(second.event, 'duplicate_suppressed'); assert.equal(first.id, second.id);
  assert.equal(fs.readdirSync(directory).filter(n => n.endsWith('.event.json')).length, 1);
});
test('pre-cancel and cancellation during read cannot publish an event', async t => {
  const { options, transport, directory } = setup(t);
  const controller = new AbortController(); controller.abort();
  let reads = 0;
  await assert.rejects(observe(options, { ...transport, signal: controller.signal, read: async () => { reads++; } }), /WATCH_CANCELLED/);
  assert.equal(reads, 0);
  const mid = new AbortController();
  await assert.rejects(observe(options, { ...transport, signal: mid.signal, read: async () => {
    mid.abort(); return { binding: receipt, kind: 'synthetic_terminal_sample', text: 'DONE' };
  } }), /WATCH_CANCELLED/);
  assert.equal(fs.readdirSync(directory).filter(n => n.endsWith('.event.json')).length, 0);
  assert.equal((await observe(options, transport)).event, 'pending_verification');
});
test('unknown read failure preserves journal and external lock, with no automatic retry', async t => {
  const { options, transport, directory } = setup(t);
  const externalLock = path.join(directory, 'business.lock'); fs.writeFileSync(externalLock, 'frozen');
  let calls = 0;
  await assert.rejects(observe(options, { ...transport, read: async () => { calls++; throw Error('UNKNOWN_RESULT'); } }), /UNKNOWN_RESULT/);
  assert.equal(calls, 1); assert.equal(fs.readFileSync(externalLock, 'utf8'), 'frozen');
  const before = fs.readdirSync(directory);
  await assert.rejects(observe({ ...options, baselineSha256: textDigest('different') }, transport), /JOURNAL_CONFLICT/);
  assert.deepEqual(fs.readdirSync(directory), before);
});
test('partial publication and corruption block without automatic cleanup', async t => {
  const { options, transport, directory } = setup(t);
  const first = await observe(options, transport);
  const event = path.join(directory, first.id + '.event.json'); fs.writeFileSync(event, 'corrupt');
  await assert.rejects(observe(options, transport), /JOURNAL_CONFLICT/);
  assert.equal(fs.readFileSync(event, 'utf8'), 'corrupt');
  fs.writeFileSync(path.join(directory, 'unknown.pending'), 'uncertain');
  await assert.rejects(observe(options, transport), /UNKNOWN_PUBLICATION/);
  assert.equal(fs.readFileSync(path.join(directory, 'unknown.pending'), 'utf8'), 'uncertain');
});
test('missing identity or text, and absent transport, fail closed', async t => {
  const { options, transport } = setup(t);
  await assert.rejects(observe(options), /OFFLINE_TRANSPORT_REQUIRED/);
  await assert.rejects(observe(options, { ...transport, read: async () => ({ binding: receipt, text: 'DONE' }) }), /UNVERIFIABLE_SAMPLE/);
});
test('two fresh Node processes replay durable event without duplicate publication', t => {
  const { directory } = setup(t);
  const script = path.resolve('scripts/orca-receipt-observer.mjs');
  const first = JSON.parse(execFileSync(process.execPath, [script, 'demo', directory], { encoding: 'utf8' }));
  const second = JSON.parse(execFileSync(process.execPath, [script, 'replay', first.directory], { encoding: 'utf8' }));
  assert.equal(first.event, 'pending_verification'); assert.equal(second.event, 'duplicate_suppressed');
  assert.equal(first.id, second.id); assert.equal(second.executionDispatched, false);
});
test('unsupported live/approval CLI rejected before any connection', () => {
  const result = (() => { try { execFileSync(process.execPath, ['scripts/orca-receipt-observer.mjs', 'live', '/tmp'], { stdio: 'pipe' }); }
    catch (e) { return e; } })();
  assert.equal(result.status, 1); assert.match(result.stderr.toString(), /LIVE_TRANSPORT_NOT_CONNECTED/);
});
test('timeout then restart keeps original binding and allows only one local pending event', async t => {
  const { options, transport, directory } = setup(t, ['working']);
  assert.equal((await observe(options, transport)).event, 'timeout_no_change');
  const baselineFile = fs.readdirSync(directory).find(n => n.endsWith('.binding.json'));
  const baseline = fs.readFileSync(path.join(directory, baselineFile));
  const changed = { ...transport, read: async () => ({ kind: 'synthetic_terminal_sample', binding: receipt, text: 'DONE' }) };
  const first = await observe(options, changed);
  const second = await observe(options, changed);
  assert.equal(first.event, 'pending_verification'); assert.equal(second.event, 'duplicate_suppressed');
  assert.deepEqual(fs.readFileSync(path.join(directory, baselineFile)), baseline);
  assert.equal(second.executionDispatched, false); assert.equal(second.notificationDelivered, false);
});
