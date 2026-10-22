#!/usr/bin/env node
// Offline contract rehearsal only. No subprocess, model, network or runtime APIs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(code); };
const keys = ['runtimeId', 'workspaceId', 'runId', 'taskId', 'dispatchId', 'generation', 'terminal'];
export function binding(value) {
  if (!value || Object.keys(value).length !== keys.length) fail('EXACT_BINDING_REQUIRED');
  const out = {};
  for (const key of keys) {
    const v = value[key];
    if (key === 'generation' ? !Number.isSafeInteger(v) || v < 1 : typeof v !== 'string' || !v.trim() || v.length > 512)
      fail('EXACT_BINDING_REQUIRED');
    out[key] = v;
  }
  if (!/^term_[a-f0-9-]{36}$/i.test(out.terminal)) fail('INVALID_TERMINAL');
  return out;
}
// New durable files are published without replacement. A partial temp, corrupt
// record or unknown outcome requires human inspection, never execution retry.
function publish(directory, name, value) {
  const destination = path.join(directory, name);
  const data = JSON.stringify(value);
  if (fs.existsSync(destination)) {
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let actual;
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 65536) fail('JOURNAL_INVALID');
      actual = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
    if (actual !== data) fail('JOURNAL_CONFLICT');
    return false;
  }
  const temporary = path.join(directory, `${randomUUID()}.pending`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Never replace an existing record, even when another process wins the race.
  try { fs.linkSync(temporary, destination); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Retain the temp on uncertain publication; reconciliation is manual.
    fail('CONCURRENT_PUBLICATION_REQUIRES_REVIEW');
  }
  fs.unlinkSync(temporary);
  const dir = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return true;
}
export async function observe({ receipt, baselineSha256, directory, timeoutMs = 3000, intervalMs = 1000 },
    { read, clock, sleep, signal } = {}) {
  const expected = binding(receipt);
  if (!/^[a-f0-9]{64}$/.test(baselineSha256 || '')) fail('BASELINE_REQUIRED');
  if (!path.isAbsolute(directory || '') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) fail('INVALID_OPTIONS');
  if ([read, clock, sleep].some(v => typeof v !== 'function')) fail('OFFLINE_TRANSPORT_REQUIRED');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('UNSAFE_JOURNAL');
  if (fs.readdirSync(directory).some(n => n.endsWith('.pending'))) fail('UNKNOWN_PUBLICATION_REQUIRES_REVIEW');
  // One pinned baseline per exact attempt; changing baseline requires reconciliation.
  publish(directory, hash(expected) + '.binding.json', { version: 1, binding: expected, baselineSha256 });
  const started = clock();
  const cancelled = () => { if (signal?.aborted) fail('WATCH_CANCELLED'); };
  const flags = { approvalIssued: false, canCompleteTask: false, executionDispatched: false,
    sourceAuthenticated: false, notificationDelivered: false, scope: 'OFFLINE_SYNTHETIC_ONLY' };
  do {
    cancelled();
    const sample = await read();
    cancelled();
    if (clock() - started >= timeoutMs) break;
    if (!sample || hash(binding(sample.binding)) !== hash(expected)) fail('IDENTITY_MISMATCH');
    if (sample.kind !== 'synthetic_terminal_sample' || typeof sample.text !== 'string' || Buffer.byteLength(sample.text) > 262144)
      fail('UNVERIFIABLE_SAMPLE');
    const observedSha256 = textDigest(sample.text);
    if (observedSha256 !== baselineSha256) {
      const id = hash([expected, baselineSha256, observedSha256]);
      const event = { version: 1, id, binding: expected, baselineSha256, observedSha256,
        state: 'pending_verification', requiresHumanReview: true, ...flags };
      const created = publish(directory, id + '.event.json', event);
      return { event: created ? 'pending_verification' : 'duplicate_suppressed', id, ...flags };
    }
    await sleep(Math.min(intervalMs, timeoutMs - (clock() - started)), signal);
  } while (clock() - started < timeoutMs);
  cancelled();
  return { event: 'timeout_no_change', ...flags };
}
export const textDigest = text => createHash('sha256').update(text).digest('hex');

export async function main(argv) {
  if (argv.length !== 2 || !['demo', 'replay'].includes(argv[0]) || !path.isAbsolute(argv[1]))
    fail('USAGE: demo ABSOLUTE_PARENT | replay ABSOLUTE_DEMO_DIRECTORY; LIVE_TRANSPORT_NOT_CONNECTED');
  let directory = argv[1];
  if (argv[0] === 'demo') {
    directory = fs.mkdtempSync(path.join(directory, 'orca-observer-synthetic-'));
    const receipt = { runtimeId: 'synthetic-runtime', workspaceId: 'synthetic-workspace', runId: 'synthetic-run',
      taskId: 'synthetic-task', dispatchId: 'synthetic-dispatch', generation: 1,
      terminal: 'term_00000000-0000-0000-0000-000000000001' };
    fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify({ receipt, baselineSha256: textDigest('working'),
      samples: ['working', '1. Approve? DONE'].map(text => ({ kind: 'synthetic_terminal_sample', binding: receipt, text })) }), { flag: 'wx', mode: 0o600 });
  }
  const fixtureFile = path.join(directory, 'fixture.json');
  if (fs.lstatSync(fixtureFile).size > 1048576) fail('FIXTURE_TOO_LARGE');
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  if (!Array.isArray(fixture.samples) || !fixture.samples.length) fail('SAMPLES_REQUIRED');
  let now = 0, index = 0;
  const result = await observe({ receipt: fixture.receipt, baselineSha256: fixture.baselineSha256, directory: path.join(directory, 'journal') },
    { read: async () => fixture.samples[Math.min(index++, fixture.samples.length - 1)], clock: () => now, sleep: async ms => { now += ms; } });
  return { ...result, directory };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message, executionDispatched: false, approvalIssued: false }) + '\n');
    process.exitCode = 1;
  });
}
