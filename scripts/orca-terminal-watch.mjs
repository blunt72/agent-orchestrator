#!/usr/bin/env node
/**
 * Read-only Orca terminal watcher. One process polls locally; no AI call is
 * made for intermediate states. In particular this file cannot issue any
 * `terminal send` or approve an interactive prompt.
 *
 * Orca's JSON field layout is deployment-dependent. The caller MUST select
 * a textual leaf explicitly with --field. Use `inspect` to find candidates.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export class WatchError extends Error {
  constructor(code) { super(code); this.name = 'WatchError'; this.code = code; }
}

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const terminalId = /^term_[a-f0-9-]{36}$/i;
const fieldPath = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,7}$/;
const shaPattern = /^[a-f0-9]{64}$/;

export function readArgs(argv) {
  const mode = argv[0];
  if (!['inspect', 'snapshot', 'watch'].includes(mode)) throw new WatchError('INVALID_MODE');
  const raw = {};
  for (let i = 1; i < argv.length; i += 2) {
    const name = argv[i];
    if (!name?.startsWith('--') || !argv[i + 1] || raw[name] !== undefined)
      throw new WatchError('INVALID_OPTIONS');
    raw[name] = argv[i + 1];
  }
  const allowed = new Set(['--terminal', '--field', '--interval-ms', '--timeout-ms', '--limit', '--baseline-sha256']);
  if (Object.keys(raw).some(k => !allowed.has(k))) throw new WatchError('INVALID_OPTIONS');
  const terminal = raw['--terminal'];
  const field = raw['--field'];
  if (!terminalId.test(terminal || '')) throw new WatchError('INVALID_TERMINAL_ID');
  if (mode !== 'inspect' && !fieldPath.test(field || '')) throw new WatchError('FIELD_REQUIRED');
  if (field !== undefined && !fieldPath.test(field)) throw new WatchError('INVALID_FIELD');
  const integer = (key, defaultValue, min, max) => {
    const x = raw[key] === undefined ? defaultValue : Number(raw[key]);
    if (!Number.isSafeInteger(x) || x < min || x > max) throw new WatchError('INVALID_OPTIONS');
    return x;
  };
  const intervalMs = integer('--interval-ms', 5000, 1000, 60000);
  const timeoutMs = integer('--timeout-ms', 120000, 1000, 600000);
  const limit = integer('--limit', 80, 1, 200);
  const baselineSha256 = raw['--baseline-sha256'];
  if (baselineSha256 !== undefined && (mode !== 'watch' || !shaPattern.test(baselineSha256)))
    throw new WatchError('INVALID_BASELINE_DIGEST');
  return { mode, terminal, field, intervalMs, timeoutMs, limit, baselineSha256 };
}

/** Never run a shell. The command and operation are intentionally fixed. */
export function readOrcaTerminal({ terminal, limit, executable = 'orca', run = execFile }) {
  if (!terminalId.test(terminal || '')) throw new WatchError('INVALID_TERMINAL_ID');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new WatchError('INVALID_OPTIONS');
  return new Promise((ok, fail) => run(executable,
    ['terminal', 'read', '--terminal', terminal, '--limit', String(limit), '--json'],
    { shell: false, timeout: 15000, maxBuffer: 524288 }, (error, stdout) => {
      if (error) return fail(new WatchError('ORCA_READ_FAILED'));
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 524288)
        return fail(new WatchError('ORCA_OUTPUT_INVALID'));
      try {
        const parsed = JSON.parse(stdout);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
            (Object.hasOwn(parsed, 'ok') && parsed.ok !== true))
          throw new Error('invalid');
        ok(parsed);
      } catch { fail(new WatchError('ORCA_JSON_INVALID')); }
    }));
}

export function selectText(payload, path) {
  if (!fieldPath.test(path || '')) throw new WatchError('INVALID_FIELD');
  let node = payload;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key))
      throw new WatchError('FIELD_NOT_FOUND');
    node = node[key];
  }
  if (Array.isArray(node) && node.every(v => typeof v === 'string')) node = node.join('\n');
  if (typeof node !== 'string' || Buffer.byteLength(node) > 262144)
    throw new WatchError('FIELD_NOT_TEXT');
  return node;
}

/** Only expose leaf names/types and lengths, never actual terminal contents. */
export function inspectFields(payload) {
  const result = [];
  function visit(node, path, depth) {
    if (result.length >= 64 || depth > 8) return;
    if (typeof node === 'string') {
      result.push({ path, type: 'text', length: node.length });
    } else if (Array.isArray(node)) {
      if (node.every(v => typeof v === 'string'))
        result.push({ path, type: 'text_array', length: node.length });
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node).slice(0, 64)) {
        if (/^[A-Za-z_$][\w$]*$/.test(k)) visit(node[k], path ? `${path}.${k}` : k, depth + 1);
      }
    }
  }
  visit(payload, '', 0);
  return result;
}

const defaultWait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new WatchError('WATCH_CANCELLED'));
  let settled = false;
  const finish = (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    err ? reject(err) : resolve();
  };
  const onAbort = () => finish(new WatchError('WATCH_CANCELLED'));
  const timer = setTimeout(() => finish(), ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Return on the first textual change, deadline, or cancellation. A text change
 * is NOT a verified completion or authorization. Caller must inspect it.
 */
export async function watchTerminal(opts, { read, sleep = defaultWait, clock = () => Date.now(), signal } = {}) {
  if (!opts || !fieldPath.test(opts.field || '') || !Number.isSafeInteger(opts.timeoutMs) ||
      opts.timeoutMs < 1000 || opts.timeoutMs > 600000 || !Number.isSafeInteger(opts.intervalMs) ||
      opts.intervalMs < 1000 || opts.intervalMs > 60000) throw new WatchError('INVALID_OPTIONS');
  if (typeof read !== 'function') throw new WatchError('READ_FUNCTION_REQUIRED');
  const started = clock();
  const first = selectText(await read(), opts.field);
  const firstHash = sha256(first);
  const baseline = opts.baselineSha256 || firstHash;
  if (opts.baselineSha256 && !shaPattern.test(opts.baselineSha256)) throw new WatchError('INVALID_BASELINE_DIGEST');
  let checks = 1;
  const changed = (value) => ({
    ok: true, event: 'terminal_content_changed_unverified',
    baselineSha256: baseline, observedSha256: sha256(value),
    checks, elapsedMs: Math.max(0, clock() - started),
    approvalIssued: false, sourceAuthenticated: false, canCompleteTask: false,
    requiresHumanReview: true
  });
  if (firstHash !== baseline) return changed(first);
  while (clock() - started < opts.timeoutMs) {
    if (signal?.aborted) throw new WatchError('WATCH_CANCELLED');
    const remaining = opts.timeoutMs - (clock() - started);
    await sleep(Math.min(opts.intervalMs, remaining), signal);
    if (signal?.aborted) throw new WatchError('WATCH_CANCELLED');
    // Avoid another read if the wait itself reached the time limit.
    if (clock() - started >= opts.timeoutMs) break;
    const observed = selectText(await read(), opts.field);
    checks++;
    if (sha256(observed) !== baseline) return changed(observed);
  }
  return { ok: true, event: 'timeout_no_change', baselineSha256: baseline,
    checks, elapsedMs: Math.max(0, clock() - started),
    approvalIssued: false, sourceAuthenticated: false, canCompleteTask: false,
    requiresHumanReview: false };
}

export async function main(argv, { run = execFile } = {}) {
  const opts = readArgs(argv);
  const read = () => readOrcaTerminal({ ...opts, run });
  if (opts.mode === 'inspect' || opts.mode === 'snapshot') {
    const payload = await read();
    if (opts.mode === 'inspect') return { ok: true, event: 'read_only_field_inspection', fields: inspectFields(payload),
      approvalIssued: false, canCompleteTask: false };
    const value = selectText(payload, opts.field);
    return { ok: true, event: 'baseline_snapshot', field: opts.field,
      baselineSha256: sha256(value), length: value.length,
      approvalIssued: false, sourceAuthenticated: false, canCompleteTask: false };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await watchTerminal(opts, { read, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(err => {
    const code = err instanceof WatchError ? err.code : 'UNEXPECTED_ERROR';
    process.stderr.write(JSON.stringify({ ok: false, code,
      approvalIssued: false, canCompleteTask: false }) + '\n');
    process.exitCode = code === 'WATCH_CANCELLED' ? 130 : 1;
  });
}
