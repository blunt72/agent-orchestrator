/**
 * P2-A: fail-closed policy for a future Orca transport adapter.
 * This module DOES NOT intercept external Codex tool calls.
 * Time and results are supplied by its caller; never dispatches commands.
 */
export class OrcaCallGuard {
  constructor({maxReads = 6, windowMs = 60_000, maxIdentical = 3, maxDurationMs = 10 * 60_000} = {}) {
    for (const n of [maxReads, windowMs, maxIdentical, maxDurationMs]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('INVALID_GUARD_POLICY');
    }
    this.policy = {maxReads, windowMs, maxIdentical, maxDurationMs};
    this.states = new Map();
  }
  #valid(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value); }
  #key(taskId, terminalId) {
    if (!this.#valid(taskId) || !this.#valid(terminalId)) throw new Error('INVALID_GUARD_IDENTITY');
    return JSON.stringify([taskId, terminalId]);
  }
  #time(now) { if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_GUARD_TIME'); }
  #state(taskId, terminalId, now) {
    this.#time(now);
    const key = this.#key(taskId, terminalId);
    let state = this.states.get(key);
    if (!state) {
      state = {started: now, lastNow: now, reads: [], lastDigest: null, identical: 0, stopped: null, pendingRead: false};
      this.states.set(key, state);
    }
    if (now < state.lastNow) throw new Error('NON_MONOTONIC_GUARD_TIME');
    state.lastNow = now;
    return state;
  }
  /** Call immediately before each real terminal-read dispatch, not after it. */
  beginRead({taskId, terminalId, now = Date.now()}) {
    const state = this.#state(taskId, terminalId, now);
    if (state.stopped) return {allow:false, reason:state.stopped};
    if (state.pendingRead) return {allow:false, reason:'READ_IN_FLIGHT'};
    if (now - state.started >= this.policy.maxDurationMs) state.stopped = 'DURATION_BUDGET_EXHAUSTED';
    state.reads = state.reads.filter(t => now - t < this.policy.windowMs);
    if (state.reads.length >= this.policy.maxReads) state.stopped = 'READ_RATE_BUDGET_EXHAUSTED';
    if (state.stopped) return {allow:false, reason:state.stopped};
    state.reads.push(now);
    state.pendingRead = true;
    return {allow:true, reason:'READ_PERMITTED'};
  }
  /** Digest is sha256 of normalized observed state, produced by a trusted local adapter. */
  finishRead({taskId, terminalId, now = Date.now(), digest, changed = false}) {
    const state = this.#state(taskId, terminalId, now);
    if (!state.pendingRead) throw new Error('NO_READ_IN_FLIGHT');
    state.pendingRead = false;
    if (!/^[a-f0-9]{64}$/.test(digest ?? '') || typeof changed !== 'boolean') {
      state.stopped = 'INVALID_READ_OBSERVATION';
      return {allow:false, reason:state.stopped};
    }
    if (changed || state.lastDigest !== digest) {
      state.identical = 1;
      state.lastDigest = digest;
    } else {
      state.identical++;
    }
    if (state.identical >= this.policy.maxIdentical) state.stopped = 'REPEATED_UNCHANGED_STATE';
    if (state.stopped) return {allow:false, reason:state.stopped};
    return {allow:true, reason:'OBSERVATION_RECORDED', identical:state.identical};
  }
  failRead({taskId, terminalId, now = Date.now()}) {
    const state = this.#state(taskId, terminalId, now);
    if (!state.pendingRead) throw new Error('NO_READ_IN_FLIGHT');
    state.pendingRead = false;
    state.stopped = 'READ_FAILURE_REQUIRES_REVIEW';
    return {allow:false, reason:state.stopped};
  }
  /** No approval dispatch in this adapter. Never treat numeric input as permission. */
  requestTerminalSend({taskId, terminalId, now = Date.now()}) {
    this.#state(taskId, terminalId, now);
    return {allow:false, reason:'APPROVAL_REQUIRES_SEPARATE_AUTHORIZED_ADAPTER'};
  }
  inspect({taskId, terminalId, now = Date.now()}) {
    const state = this.#state(taskId, terminalId, now);
    return {stopped:state.stopped, pendingRead:state.pendingRead, readsInWindow:state.reads.filter(t=>now-t<this.policy.windowMs).length, identical:state.identical};
  }
}
