/** Local transcript hints are untrusted. This bridge never prompts or approves. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Task } from '../tasks/task.js';
import type { TaskStore } from '../tasks/task-store.js';

export interface Binding {
  taskId: string; sessionId: string; startStepIndex: number;
  requestTime: string; actor: 'gemini'; phase: 'DOING' | 'REVIEW';
}
export interface Hint {
  event: string; sessionId: string; stepIndex: number; rowSha256: string;
  source: string; type: string; status: string;
}
export interface BridgeEvent {
  id: string; binding: Binding; stepIndex: number; rowSha256: string;
  state: 'pending_verification' | 'claimed' | 'consumed' | 'needs_human_review';
  sourceAuthenticated: false; canCompleteTask: false; approvalIssued: false;
  authorizationSha256?: string; claimedAt?: string;
}
interface State { version: 1; binding: Binding; events: BridgeEvent[]; claimed: boolean }
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail = (code: string): never => { throw new Error(code); };
const same = (a: Binding, b: Binding) => JSON.stringify(a) === JSON.stringify(b);
export function bindingFor(task: Task): Binding {
  // Orca owns dispatch/recovery for these tasks. Enforce this at the component
  // boundary too, even when callers bypass ProjectEngine or the CLI.
  if (task.orcaBinding) return fail('ORCA_BOUND_TASK_REQUIRES_ORCA_WORKFLOW');
  const p = task.pendingAgentTurn;
  if (!p || p.actor !== 'gemini' || !['DOING', 'REVIEW'].includes(p.phase) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(p.sessionId) ||
      !Number.isSafeInteger(p.startStepIndex) || p.startStepIndex < -1 ||
      !Number.isFinite(Date.parse(p.requestTime)) || typeof task.id !== 'string' || !task.id.length)
    return fail('INVALID_PENDING_BINDING');
  return {taskId: task.id, sessionId: p.sessionId, startStepIndex: p.startStepIndex,
    requestTime: p.requestTime, actor: 'gemini', phase: p.phase};
}
function eligible(task: Task, binding: Binding): void {
  if (task.status !== binding.phase || task.pendingHumanResponse || !same(bindingFor(task), binding))
    fail('TASK_CHANGED_OR_REQUIRES_HUMAN');
}

/** Use one explicit private directory per AgentHub store. Never auto-clear locks. */
export class GeminiTaskEventBridge {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) fail('ABSOLUTE_BRIDGE_DIRECTORY_REQUIRED');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    if (fs.lstatSync(directory).isSymbolicLink()) fail('UNSAFE_BRIDGE_DIRECTORY');
  }
  private transaction<T>(taskId: string, operation: (state: State | undefined) => [State, T]): T {
    const base = path.join(this.directory, digest(taskId));
    const lock = base + '.lock';
    // Exclusive creation serializes independent bridge processes, including across awaits
    // (no await occurs inside this transaction). A crash lock needs human reconciliation.
    const fd = fs.openSync(lock, 'wx', 0o600);
    let temporary: string | undefined;
    try {
      let state: State | undefined;
      try {
        const input = fs.openSync(base + '.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          if (fs.fstatSync(input).size > 4 * 1024 * 1024) fail('BRIDGE_STATE_TOO_LARGE');
          state = JSON.parse(fs.readFileSync(input, 'utf8'));
        } finally { fs.closeSync(input); }
        if (state?.version !== 1 || !Array.isArray(state.events) || typeof state.claimed !== 'boolean')
          fail('INVALID_BRIDGE_STATE');
      } catch (err: any) { if (err.code !== 'ENOENT') throw err; }
      const [next, result] = operation(state);
      const data = JSON.stringify(next);
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) fail('BRIDGE_STATE_TOO_LARGE');
      temporary = base + '.' + randomUUID() + '.tmp';
      const output = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(output, data); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      fs.renameSync(temporary, base + '.json');
      const dir = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return structuredClone(result);
    } finally {
      if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.closeSync(fd); fs.unlinkSync(lock);
    }
  }
  bind(task: Task): Binding {
    const binding = bindingFor(task);
    eligible(task, binding);
    return this.transaction(task.id, state => {
      if (state && !same(state.binding, binding)) fail('REBIND_REQUIRES_HUMAN_RECONCILIATION');
      return [state ?? {version: 1, binding, events: [], claimed: false}, binding];
    });
  }
  ingest(task: Task, hint: Hint): BridgeEvent {
    const binding = bindingFor(task);
    eligible(task, binding);
    if (hint.event !== 'model_step_observed_unverified' || hint.sessionId !== binding.sessionId ||
        !Number.isSafeInteger(hint.stepIndex) || hint.stepIndex <= binding.startStepIndex ||
        !/^[a-f0-9]{64}$/.test(hint.rowSha256) || hint.source !== 'MODEL' ||
        hint.type !== 'PLANNER_RESPONSE' || hint.status !== 'DONE') fail('INVALID_TRANSCRIPT_HINT');
    return this.transaction(task.id, state => {
      if (!state || !same(state.binding, binding)) return fail('BINDING_MISMATCH');
      const prior = state.events.find(e => e.stepIndex === hint.stepIndex);
      if (prior) {
        if (prior.rowSha256 !== hint.rowSha256) fail('TRANSCRIPT_STEP_CONFLICT');
        return [state, prior];
      }
      if (state.claimed) fail('TURN_ALREADY_CLAIMED');
      const event: BridgeEvent = {id: digest([binding, hint.stepIndex, hint.rowSha256]), binding,
        stepIndex: hint.stepIndex, rowSha256: hint.rowSha256, state: 'pending_verification',
        sourceAuthenticated: false, canCompleteTask: false, approvalIssued: false};
      state.events.push(event);
      return [state, event];
    });
  }
  /** Ordinary Node waits; only a fresh saved checkpoint can receive the hint. */
  async watch(store: Pick<TaskStore, 'getTask'>, taskId: string,
      options: {root: string; intervalMs: number; timeoutMs: number}, signal?: AbortSignal) {
    const task = await store.getTask(taskId);
    if (!task) return fail('TASK_NOT_FOUND');
    const binding = this.bind(task);
    const modulePath = '../../scripts/gemini-transcript-watch.mjs';
    const {observe, parseArgs} = await import(modulePath);
    const opts = parseArgs(['watch', '--session', binding.sessionId, '--after-step', String(binding.startStepIndex),
      '--brain-root', options.root, '--interval-ms', String(options.intervalMs), '--timeout-ms', String(options.timeoutMs)]);
    const hint = await observe(opts, {signal});
    if (hint.event !== 'model_step_observed_unverified') return hint;
    const current = await store.getTask(taskId);
    if (!current || !same(bindingFor(current), binding)) return fail('TASK_CHANGED_DURING_WATCH');
    return this.ingest(current, hint);
  }
  /**
   * Explicit human-authorized application entry only. verify must independently
   * inspect the original pending turn/evidence. A hint is never that evidence.
   * resume must restore the existing checkpoint, not send a new prompt.
   * Reserve before any async callback: crash/failure/ambiguous outcome blocks retries.
   */
  async resume(store: Pick<TaskStore, 'getTask'>, taskId: string, eventId: string,
      authorization: {humanAuthorized: true; evidence: string},
      verify: (task: Task, event: BridgeEvent) => Promise<boolean>,
      resume: (task: Task, event: BridgeEvent) => Promise<void>): Promise<void> {
    if (authorization?.humanAuthorized !== true || !authorization.evidence?.trim())
      fail('EXPLICIT_HUMAN_AUTHORIZATION_REQUIRED');
    const task = await store.getTask(taskId);
    if (!task) return fail('TASK_NOT_FOUND');
    const binding = bindingFor(task);
    eligible(task, binding);
    const event = this.transaction(taskId, state => {
      if (!state || !same(state.binding, binding)) return fail('BINDING_MISMATCH');
      const event = state.events.find(e => e.id === eventId);
      if (!event || event.state !== 'pending_verification' || state.claimed) return fail('TURN_ALREADY_CLAIMED_OR_EVENT_MISSING');
      state.claimed = true; event.state = 'claimed';
      event.authorizationSha256 = digest(authorization.evidence); event.claimedAt = new Date().toISOString();
      return [state, event];
    });
    try {
      if (await verify(structuredClone(task), structuredClone(event)) !== true) fail('INDEPENDENT_VERIFICATION_REQUIRED');
      const current = await store.getTask(taskId);
      if (!current) return fail('TASK_NOT_FOUND');
      eligible(current, binding);
      if (current.revision !== task.revision || current.ownerId !== task.ownerId ||
          current.reviewerId !== task.reviewerId || JSON.stringify(current.claim) !== JSON.stringify(task.claim))
        fail("TASK_CHANGED_DURING_VERIFICATION");
      await resume(structuredClone(current), structuredClone(event));
      this.finish(taskId, eventId, 'consumed');
    } catch (err) {
      this.finish(taskId, eventId, 'needs_human_review');
      throw err;
    }
  }
  private finish(taskId: string, id: string, status: BridgeEvent['state']) {
    this.transaction(taskId, state => {
      const event = state?.events.find(e => e.id === id);
      if (!state || !event) return fail('BRIDGE_STATE_LOST');
      event.state = status;
      return [state, undefined];
    });
  }
}
