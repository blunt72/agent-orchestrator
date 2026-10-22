#!/usr/bin/env node
/**
 * Local, read-only Antigravity-CLI transcript observer.
 * It does not call a model or CLI, send messages, approve prompts, or declare
 * task completion. A matching log row is ONLY an unauthenticated observation.
 */
import { promises as fs, constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class TranscriptWatchError extends Error {
  constructor(code) { super(code); this.name = 'TranscriptWatchError'; this.code = code; }
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_DELTA = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const sleep = (ms, signal) => new Promise((ok, fail) => {
  if (signal?.aborted) return fail(new TranscriptWatchError('WATCH_CANCELLED'));
  let timer;
  const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); fail(new TranscriptWatchError('WATCH_CANCELLED')); };
  timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); ok(); }, ms);
  signal?.addEventListener('abort', aborted, { once: true });
});

export function parseArgs(argv) {
  const mode = argv[0];
  if (!['inspect', 'watch'].includes(mode)) throw new TranscriptWatchError('INVALID_MODE');
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || Object.hasOwn(options, argv[i]))
      throw new TranscriptWatchError('INVALID_OPTIONS');
    options[argv[i]] = argv[i + 1];
  }
  const allowed = new Set(['--session', '--brain-root', '--after-step', '--interval-ms', '--timeout-ms']);
  if (Object.keys(options).some(k => !allowed.has(k))) throw new TranscriptWatchError('INVALID_OPTIONS');
  if (!UUID.test(options['--session'] || '')) throw new TranscriptWatchError('INVALID_SESSION');
  const integer = (key, fallback, min, max) => {
    const n = options[key] === undefined ? fallback : Number(options[key]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new TranscriptWatchError('INVALID_OPTIONS');
    return n;
  };
  const root = options['--brain-root'] || join(homedir(), '.gemini/antigravity-cli/brain');
  if (!isAbsolute(root)) throw new TranscriptWatchError('INVALID_ROOT');
  if (options['--after-step'] !== undefined && mode !== 'watch') throw new TranscriptWatchError('INVALID_OPTIONS');
  return {
    mode, session: options['--session'], root: resolve(root),
    afterStep: options['--after-step'] === undefined ? undefined : integer('--after-step', 0, -1, Number.MAX_SAFE_INTEGER),
    intervalMs: integer('--interval-ms', 1000, 100, 60000),
    timeoutMs: integer('--timeout-ms', 60000, 1000, 600000)
  };
}

const transcriptFile = (opts) => join(opts.root, opts.session, '.system_generated', 'logs', 'transcript.jsonl');
const fingerprint = (raw) => createHash('sha256').update(raw).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });

async function openLog(opts) {
  const filename = transcriptFile(opts);
  let h;
  try { h = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) {
    if (err.code === 'ENOENT') throw new TranscriptWatchError('TRANSCRIPT_NOT_FOUND');
    throw new TranscriptWatchError('TRANSCRIPT_UNREADABLE');
  }
  const st = await h.stat();
  if (!st.isFile() || st.size > MAX_FILE || st.size < 0) {
    await h.close(); throw new TranscriptWatchError('TRANSCRIPT_UNSAFE');
  }
  return { h, st, filename };
}

async function bytesAt(h, offset, length) {
  if (length > MAX_DELTA) throw new TranscriptWatchError('TRANSCRIPT_GROWTH_TOO_LARGE');
  const b = Buffer.alloc(length);
  let seen = 0;
  while (seen < length) {
    const { bytesRead } = await h.read(b, seen, length - seen, offset + seen);
    if (!bytesRead) throw new TranscriptWatchError('TRANSCRIPT_CHANGED_DURING_READ');
    seen += bytesRead;
  }
  return b;
}

function safeRow(raw) {
  if (!raw.length || raw.length > MAX_LINE) throw new TranscriptWatchError('TRANSCRIPT_ROW_INVALID');
  let row;
  try { row = JSON.parse(decoder.decode(raw)); }
  catch { throw new TranscriptWatchError('TRANSCRIPT_ROW_INVALID'); }
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      !Number.isSafeInteger(row.step_index) || row.step_index < 0 ||
      typeof row.source !== 'string' || typeof row.type !== 'string' || typeof row.status !== 'string')
    throw new TranscriptWatchError('TRANSCRIPT_ROW_INVALID');
  return row;
}

/** Process only newline-delimited complete rows; retain trailing partial JSON. */
export function parseChunk(chunk, carry = Buffer.alloc(0)) {
  const all = Buffer.concat([carry, chunk]);
  if (all.length > MAX_DELTA + MAX_LINE) throw new TranscriptWatchError('TRANSCRIPT_GROWTH_TOO_LARGE');
  const rows = [];
  let offset = 0;
  for (;;) {
    const end = all.indexOf(10, offset);
    if (end < 0) break;
    const raw = all.subarray(offset, end);
    offset = end + 1;
    const row = safeRow(raw);
    rows.push({ stepIndex: row.step_index, source: row.source, type: row.type,
      status: row.status, rowSha256: fingerprint(raw) });
  }
  const leftover = Buffer.from(all.subarray(offset));
  if (leftover.length > MAX_LINE) throw new TranscriptWatchError('TRANSCRIPT_ROW_TOO_LARGE');
  return { rows, carry: leftover };
}

const matches = (row) => row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE' && row.status === 'DONE';
const observation = (opts, row, scans, started) => ({
  ok: true, event: 'model_step_observed_unverified', sessionId: opts.session,
  stepIndex: row.stepIndex, source: row.source, type: row.type, status: row.status,
  rowSha256: row.rowSha256, checks: scans, elapsedMs: Date.now() - started,
  sourceAuthenticated: false, sessionIdentityVerified: false,
  turnCompletionVerified: false, approvalIssued: false,
  canCompleteTask: false, requiresHumanReview: true
});

export async function observe(opts, { signal, wait = sleep } = {}) {
  if (!UUID.test(opts?.session || '')) throw new TranscriptWatchError('INVALID_SESSION');
  const { h, st, filename } = await openLog(opts);
  const started = Date.now();
  try {
    // A single initial read establishes a stable baseline. New checks read only
    // appended bytes (no repeated whole-file parsing during quiet periods).
    let carry = Buffer.alloc(0);
    let lastIndex = -1;
    let count = 0;
    let firstAfterCursor;
    let rows;
    // Even 64MB historical logs are parsed in bounded local chunks.
    for (let pos = 0; pos < st.size;) {
      const length = Math.min(1024 * 1024, st.size - pos);
      const batch = await bytesAt(h, pos, length);
      pos += length;
      ({ rows, carry } = parseChunk(batch, carry));
      for (const row of rows) {
        if (row.stepIndex <= lastIndex) throw new TranscriptWatchError('TRANSCRIPT_STEP_REORDERED');
        lastIndex = row.stepIndex;
        count++;
        if (!firstAfterCursor && opts.afterStep !== undefined && row.stepIndex > opts.afterStep && matches(row))
          firstAfterCursor = row;
      }
    }
    const lastStep = lastIndex;
    if (opts.mode === 'inspect') return {
      ok: true, event: 'local_transcript_inspection', sessionId: opts.session,
      rows: count, lastStepIndex: lastStep, bytes: st.size,
      sourceAuthenticated: false, sessionIdentityVerified: false,
      turnCompletionVerified: false, approvalIssued: false, canCompleteTask: false
    };
    if (opts.afterStep !== undefined) {
      if (opts.afterStep > lastStep) throw new TranscriptWatchError('CURSOR_AHEAD_OF_LOG');
      if (firstAfterCursor) return observation(opts, firstAfterCursor, 1, started);
    }
    // Default: from end, never treat historical events as new work.
    let offset = st.size;
    let checks = 1;
    while (Date.now() - started < opts.timeoutMs) {
      if (signal?.aborted) throw new TranscriptWatchError('WATCH_CANCELLED');
      const remaining = opts.timeoutMs - (Date.now() - started);
      await wait(Math.min(opts.intervalMs, remaining), signal);
      if (signal?.aborted) throw new TranscriptWatchError('WATCH_CANCELLED');
      if (Date.now() - started >= opts.timeoutMs) break;
      let current;
      try { current = await fs.stat(filename); }
      catch { throw new TranscriptWatchError('TRANSCRIPT_DISAPPEARED'); }
      if (current.dev !== st.dev || current.ino !== st.ino || current.size < offset || current.size > MAX_FILE)
        throw new TranscriptWatchError('TRANSCRIPT_REPLACED_OR_TRUNCATED');
      checks++;
      if (current.size === offset) continue;
      const newBytes = await bytesAt(h, offset, current.size - offset);
      offset = current.size;
      ({ rows, carry } = parseChunk(newBytes, carry));
      for (const row of rows) {
        if (row.stepIndex <= lastIndex) throw new TranscriptWatchError('TRANSCRIPT_STEP_REORDERED');
        lastIndex = row.stepIndex;
        if (matches(row)) return observation(opts, row, checks, started);
      }
    }
    return { ok: true, event: 'timeout_no_new_matching_step', sessionId: opts.session,
      lastStepIndex: lastIndex, checks, elapsedMs: Date.now() - started,
      sourceAuthenticated: false, sessionIdentityVerified: false,
      turnCompletionVerified: false, approvalIssued: false, canCompleteTask: false };
  } finally { await h.close(); }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const ctrl = new AbortController();
  const cancel = () => ctrl.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { return await observe(opts, { signal: ctrl.signal }); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(err => {
      const code = err instanceof TranscriptWatchError ? err.code : 'UNEXPECTED_ERROR';
      process.stderr.write(JSON.stringify({ok:false, code, approvalIssued:false, canCompleteTask:false}) + '\n');
      process.exitCode = code === 'WATCH_CANCELLED' ? 130 : 1;
    });
}
