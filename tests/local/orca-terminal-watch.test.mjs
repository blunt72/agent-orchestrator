import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WatchError, readArgs, readOrcaTerminal, selectText, inspectFields,
  watchTerminal, main, sha256
} from '../../scripts/orca-terminal-watch.mjs';

const terminal = 'term_aaaaaaaa-0000-4000-8000-000000000009';
const options = { field: 'result.output', timeoutMs: 10000, intervalMs: 1000 };

function fake(values) {
  let pos = 0, now = 0;
  return {
    read: async () => ({ result: { output: values[Math.min(pos++, values.length - 1)] } }),
    sleep: async (ms) => { now += ms; },
    clock: () => now
  };
}

test('input is constrained; never accepts free-form terminal commands or approval flags', () => {
  assert.deepEqual(readArgs(['watch', '--terminal', terminal, '--field', 'result.output']).intervalMs, 5000);
  for (const args of [
    ['watch', '--terminal', terminal],
    ['watch', '--terminal', terminal, '--field', 'result.output', '--approve', '1'],
    ['watch', '--terminal', 'term_$(echo hi)', '--field', 'result.output'],
    ['watch', '--terminal', terminal, '--field', 'result.output', '--interval-ms', '0'],
    ['inspect', '--terminal', terminal, '--baseline-sha256', 'a'.repeat(64)]
  ]) assert.throws(() => readArgs(args), WatchError);
});

test('CLI runner uses only read, never terminal send, without invoking a shell', async () => {
  const invocations = [];
  const run = (file, args, settings, cb) => {
    invocations.push({ file, args, settings });
    cb(null, JSON.stringify({ ok: true, result: { output: 'hello' } }));
  };
  assert.equal((await readOrcaTerminal({ terminal, limit: 80, run })).result.output, 'hello');
  assert.deepEqual(invocations[0].args, ['terminal', 'read', '--terminal', terminal, '--limit', '80', '--json']);
  assert.equal(invocations[0].settings.shell, false);
  assert.equal(invocations[0].args.includes('send'), false);
});

test('field selection fails closed when the selected field is absent or not text', () => {
  assert.equal(selectText({ result: { lines: ['a', 'b'] } }, 'result.lines'), 'a\nb');
  assert.throws(() => selectText({ result: { output: { risky: true } } }, 'result.output'), /FIELD_NOT_TEXT/);
  assert.throws(() => selectText({ result: {} }, 'result.output'), /FIELD_NOT_FOUND/);
  assert.deepEqual(inspectFields({ result: { output: 'SECRET', lines: ['x'] } }), [
    { path: 'result.output', type: 'text', length: 6 },
    { path: 'result.lines', type: 'text_array', length: 1 }
  ]);
});

test('unchanged terminal content triggers NO approval and local timeout', async () => {
  const f = fake(['same', 'same', 'same', 'same']);
  const result = await watchTerminal({ ...options, timeoutMs: 3000 }, f);
  assert.equal(result.event, 'timeout_no_change');
  assert.equal(result.checks, 3);
  assert.equal(result.approvalIssued, false);
  assert.equal(result.canCompleteTask, false);
});

test('first content change returns only a notification, not a verified completion', async () => {
  const result = await watchTerminal(options, fake(['initial', 'initial', '1. Approve?', 'newer']));
  assert.equal(result.event, 'terminal_content_changed_unverified');
  assert.equal(result.observedSha256, sha256('1. Approve?'));
  assert.equal(result.checks, 3);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.approvalIssued, false);
  assert.equal(result.sourceAuthenticated, false);
  assert.equal(result.canCompleteTask, false);
  assert.equal(JSON.stringify(result).includes('Approve?'), false);
});

test('explicit baseline detects already-changed terminal output on first read', async () => {
  const result = await watchTerminal({ ...options, baselineSha256: sha256('old') }, fake(['new']));
  assert.equal(result.checks, 1);
  assert.equal(result.event, 'terminal_content_changed_unverified');
});

test('cancellation ends watcher without sending terminal keystrokes', async () => {
  const controller = new AbortController();
  const f = fake(['a', 'a', 'a']);
  await assert.rejects(watchTerminal(options, {
    ...f,
    signal: controller.signal,
    sleep: async () => controller.abort()
  }), /WATCH_CANCELLED/);
});

test('malformed responses stop rather than being treated as approval', async () => {
  const failed = (file, args, settings, cb) => cb(null, '{not json');
  await assert.rejects(readOrcaTerminal({ terminal, limit: 80, run: failed }), /ORCA_JSON_INVALID/);
  const rejected = (file, args, settings, cb) => cb(null, JSON.stringify({ ok: false }));
  await assert.rejects(readOrcaTerminal({ terminal, limit: 80, run: rejected }), /ORCA_JSON_INVALID/);
});

test('inspect mode returns fields only and no terminal output values', async () => {
  const run = (file, args, settings, cb) => cb(null, JSON.stringify({ ok: true, result: { output: 'PRIVATE' } }));
  const result = await main(['inspect', '--terminal', terminal], { run });
  assert.equal(result.event, 'read_only_field_inspection');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});


test('snapshot exposes a digest for avoiding the initial-state race', async () => {
  const run = (file, args, settings, cb) => cb(null, JSON.stringify({ ok: true, result: { output: 'PRIVATE' } }));
  const result = await main(['snapshot', '--terminal', terminal, '--field', 'result.output'], { run });
  assert.equal(result.event, 'baseline_snapshot');
  assert.equal(result.baselineSha256, sha256('PRIVATE'));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
