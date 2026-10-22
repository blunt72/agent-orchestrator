import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Task, TaskResult } from "../tasks/task.js";
import type { TaskEvent } from "../tasks/task-events.js";
import { TaskRevisionStore } from "./task-revision-store.js";
import { withTaskFileLock } from "./task-file-lock.js";
import { readOrcaApprovalRegistry } from "./orca-approval-registry.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { inspectOrcaCompletionSnapshotReadiness } from "./orca-completion-readiness.js";
import { inspectOrcaOperationalSources } from "./orca-operational-sources.js";
import { writeTaskEvent, verifyTaskEventReadOnly } from "./task-event-store.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const validDigest = (raw: unknown): raw is string => typeof raw === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(raw);
const fail = (code: string): never => { throw Error(code); };
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
type Issuance = ReturnType<typeof readOrcaApprovalRegistry>;

export interface OrcaLimitedCompletionRecord {
  version: 1;
  purpose: "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION";
  completedAt: string;
  approval: Issuance;
  sourcePolicyDigest: string;
  originalTask: Task;
  originalTaskDigest: string;
  originalSources: Omit<Awaited<ReturnType<typeof inspectOrcaOperationalSources>>, "revalidate">;
  outbox: { state: "PENDING" | "PROJECTED"; event: TaskEvent };
}
type CompletionRecord = OrcaLimitedCompletionRecord;
export interface LimitedCompletionOptions {
  projectRoot: string;
  sessionsRoot: string;
  taskId: string;
  expectedProposalDigest: string;
  expectedSourcePolicyDigest: string;
  rawManifest: string;
  rawSourcePolicy: string;
  action: "complete" | "reconcile";
}

function resultFor(original: Task, issuance: Issuance): TaskResult {
  return { status: "PASS", summary: `Limited local human acceptance only; retained gap: ${issuance.historicalGap}; ` +
    "provider source authentication and global Phase 0/1 acceptance are not established.",
    changedFiles: [...issuance.completion.allowedFiles], testStatus: "PASS", reviewStatus: "PASS",
    rounds: original.currentRound, ...(original.testCommand ? { testCommand: original.testCommand } : {}) };
}
function eventFor(taskId: string, completedAt: string, issuance: Issuance, sourcePolicyDigest: string): TaskEvent {
  return { id: `orca-limited-completion-${issuance.approvalDigest}`, taskId, timestamp: completedAt,
    type: "TASK_COMPLETED", actor: issuance.completion.operator.subject,
    details: { from: "REVIEW", to: "DONE", scope: "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION",
      approvalDigest: issuance.approvalDigest, proposalDigest: issuance.proposalDigest, decisionDigest: issuance.decisionDigest,
      manifestDigest: issuance.completion.manifestDigest, sourcePolicyDigest, historicalGap: issuance.historicalGap,
      sourceAuthenticated: false, globalGateApproved: false } };
}
function completedTask(record: CompletionRecord): Task {
  const original = record.originalTask;
  return { ...original, status: "DONE", revision: original.revision! + (record.outbox.state === "PENDING" ? 1 : 2),
    updatedAt: record.completedAt, completedAt: record.completedAt, result: resultFor(original, record.approval),
    progress: 100, nextAction: record.outbox.state === "PENDING"
      ? "Limited local acceptance committed; explicit completion-event reconciliation required"
      : "Limited local acceptance complete; no global Gate or project rollup approval",
    orcaCompletion: record };
}

/** Operator-only route; no validator callback, task payload or boolean grants
 * completion. Trusted roots/pins are configuration, never agent instructions.
 * Participating filesystem writers only; no provider calls, tests or parent rollup.
 */
export async function completeOrcaLimitedPilot(input: LimitedCompletionOptions) {
  const options = JSON.parse(JSON.stringify(input)) as LimitedCompletionOptions;
  if (!exact(options, ["projectRoot", "sessionsRoot", "taskId", "expectedProposalDigest", "expectedSourcePolicyDigest",
    "rawManifest", "rawSourcePolicy", "action"]) || typeof options.projectRoot !== "string" || typeof options.sessionsRoot !== "string" ||
    !path.isAbsolute(options.projectRoot) || !path.isAbsolute(options.sessionsRoot) ||
    typeof options.taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(options.taskId) ||
    !validDigest(options.expectedProposalDigest) || !validDigest(options.expectedSourcePolicyDigest) ||
    typeof options.rawManifest !== "string" || Buffer.byteLength(options.rawManifest) > 32768 ||
    typeof options.rawSourcePolicy !== "string" || Buffer.byteLength(options.rawSourcePolicy) > 32768 ||
    sha(options.rawSourcePolicy) !== options.expectedSourcePolicyDigest || !["complete", "reconcile"].includes(options.action)) fail("INVALID_LIMITED_COMPLETION_INPUT");
  for (const root of [options.projectRoot, options.sessionsRoot]) if (await fs.realpath(root) !== root) fail("INVALID_COMPLETION_ROOT");
  const busy = () => Error("LIMITED_COMPLETION_BUSY");
  return withTaskFileLock(options.projectRoot, options.taskId, "task-executions", busy, () =>
    withTaskFileLock(options.projectRoot, options.taskId, "task-writes", busy, async () => {
      const store = new TaskRevisionStore(options.projectRoot);
      const live = await store.read(options.taskId) as unknown as Task | null;
      if (!live?.orcaBinding) return fail("LIMITED_COMPLETION_TASK_NOT_READY");
      const bound = parseOrcaCompletionBinding(JSON.stringify(live.orcaBinding));
      const scope = { taskId: options.taskId, projectId: bound.binding.projectId, generation: bound.binding.generation, bindingDigest: bound.digest };
      const issuance = readOrcaApprovalRegistry(options.projectRoot, options.sessionsRoot, scope, options.expectedProposalDigest);
      let record = live.orcaCompletion;
      const replay = record !== undefined;
      if (replay) {
        if (!exact(record, ["version", "purpose", "completedAt", "approval", "sourcePolicyDigest", "originalTask", "originalTaskDigest", "originalSources", "outbox"]) ||
          record.version !== 1 || record.purpose !== "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION" ||
          typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt)) ||
          new Date(record.completedAt).toISOString() !== record.completedAt || Date.parse(record.completedAt) < Date.parse(issuance.completion.approvedAt) ||
          !isDeepStrictEqual(record.approval, issuance) || record.sourcePolicyDigest !== options.expectedSourcePolicyDigest ||
          !record.originalTask || record.originalTask.orcaCompletion !== undefined ||
          !validDigest(record.originalTaskDigest) || sha(JSON.stringify(record.originalTask)) !== record.originalTaskDigest ||
          !exact(record.outbox, ["state", "event"]) || !["PENDING", "PROJECTED"].includes(record.outbox.state) ||
          !isDeepStrictEqual(record.outbox.event, eventFor(options.taskId, record.completedAt, issuance, options.expectedSourcePolicyDigest)) ||
          !isDeepStrictEqual(live, completedTask(record))) fail("LIMITED_COMPLETION_REPLAY_CONFLICT");
      } else if (options.action === "reconcile") fail("NO_COMPLETION_TO_RECONCILE");
      if (record) await syncTaskDirectory(options.projectRoot);
      const original = record?.originalTask ?? live;
      if (original.id !== options.taskId || original.projectId !== scope.projectId || original.status !== "REVIEW" ||
        original.revision !== issuance.completion.expectedRevision || original.result !== undefined || original.pendingAgentTurn ||
        original.pendingHumanResponse !== undefined || original.orcaGeneration !== scope.generation ||
        original.revision > Number.MAX_SAFE_INTEGER - 2 || !Number.isSafeInteger(original.currentRound) || original.currentRound < 0) fail("LIMITED_COMPLETION_TASK_NOT_READY");
      const readiness = await inspectOrcaCompletionSnapshotReadiness(options.projectRoot, options.sessionsRoot,
        options.taskId, options.rawManifest, issuance.completion.manifestDigest, original);
      const { version: _version, purpose: _purpose, approvalId: _id, approvedAt: _at, ...subjects } = issuance.completion;
      if (!readiness.localChecksPassed || !isDeepStrictEqual(readiness.approvalSubjects, subjects) ||
        readiness.enrollmentDigest !== issuance.enrollmentDigest) fail("LIMITED_COMPLETION_ADMISSION_FAILED");
      const { revalidate, ...sources } = await inspectOrcaOperationalSources(options.projectRoot, options.sessionsRoot, original,
        options.rawManifest, issuance.completion.manifestDigest, options.rawSourcePolicy);
      if (!sources.localSourcesConsistent || sources.policyDigest !== options.expectedSourcePolicyDigest) fail("LIMITED_COMPLETION_SOURCES_FAILED");
      if (record && (record.originalSources.evidenceDigest !== sources.evidenceDigest ||
        record.originalSources.policyDigest !== sources.policyDigest ||
        record.originalSources.sourceAuthenticated !== false || record.originalSources.permissionDigestBound !== false ||
        record.originalSources.trustedClock !== false || record.originalSources.localSourcesConsistent !== true ||
        record.originalSources.canCompleteTask !== false || record.originalSources.scope !== sources.scope)) fail("LIMITED_COMPLETION_SOURCE_REPLAY_CONFLICT");
      if (await fingerprintOrcaWorkspace(bound.binding.workspacePath) !== issuance.completion.workspaceDigest ||
        !isDeepStrictEqual(await store.read(options.taskId), live) ||
        !isDeepStrictEqual(readOrcaApprovalRegistry(options.projectRoot, options.sessionsRoot, scope, options.expectedProposalDigest), issuance)) fail("LIMITED_COMPLETION_ADMISSION_CHANGED");
      revalidate();
      if (!record) {
        const completedAt = new Date().toISOString();
        if (Date.parse(completedAt) < Date.parse(issuance.completion.approvedAt)) fail("LIMITED_COMPLETION_CLOCK_BEFORE_APPROVAL");
        record = { version: 1, purpose: "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION", completedAt, approval: issuance,
          sourcePolicyDigest: options.expectedSourcePolicyDigest, originalTask: original, originalTaskDigest: sha(JSON.stringify(original)),
          originalSources: sources, outbox: { state: "PENDING", event: eventFor(options.taskId, completedAt, issuance, options.expectedSourcePolicyDigest) } };
        await persistTask(options.projectRoot, completedTask(record), live, revalidate);
      } else if (record.outbox.state === "PROJECTED") {
        await syncTaskDirectory(options.projectRoot);
        await verifyTaskEventReadOnly(options.projectRoot, record.outbox.event);
        return outcome(record, true);
      } else if (options.action === "complete") {
        await syncTaskDirectory(options.projectRoot);
        return outcome(record, true);
      }
      try {
        await writeTaskEvent(options.projectRoot, record.outbox.event, true);
        await verifyTaskEventReadOnly(options.projectRoot, record.outbox.event);
        const projected: CompletionRecord = { ...record, outbox: { ...record.outbox, state: "PROJECTED" } };
        await persistTask(options.projectRoot, completedTask(projected), completedTask(record), revalidate);
        record = projected;
      } catch {
        const observed = await store.read(options.taskId);
        const projected: CompletionRecord = { ...record, outbox: { ...record.outbox, state: "PROJECTED" } };
        if (isDeepStrictEqual(observed, completedTask(projected))) {
          await syncTaskDirectory(options.projectRoot);
          await verifyTaskEventReadOnly(options.projectRoot, projected.outbox.event); record = projected;
        } else if (!isDeepStrictEqual(observed, completedTask(record))) fail("LIMITED_COMPLETION_PERSISTENCE_UNCERTAIN");
      }
      return outcome(record, replay);
    }));
}

function outcome(record: CompletionRecord, replay: boolean) {
  return { taskId: record.originalTask.id, status: "DONE" as const,
    revision: record.originalTask.revision! + (record.outbox.state === "PROJECTED" ? 2 : 1),
    outboxState: record.outbox.state, replay, approvalDigest: record.approval.approvalDigest,
    requiresReconciliation: record.outbox.state === "PENDING",
    scope: "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION" as const, historicalGap: record.approval.historicalGap,
    sourceAuthenticated: false as const, globalGateApproved: false as const };
}

// Private commit primitive: only after admission under both shared locks.
async function persistTask(root: string, next: Task, expected: Task, revalidate: () => void) {
  const store = new TaskRevisionStore(root);
  if (!isDeepStrictEqual(await store.read(next.id), expected)) fail("LIMITED_COMPLETION_CAS_CONFLICT");
  const directory = path.join(root, "data", "tasks"), filename = path.join(directory, `${next.id}.json`);
  const temporary = path.join(directory, `.${next.id}.${randomUUID()}.completion.tmp`);
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(next, null, 2), "utf8"); await file.sync(); }
    finally { await file.close(); }
    revalidate();
    await fs.rename(temporary, filename);
    await syncTaskDirectory(root);
  } catch (error) {
    if (isDeepStrictEqual(await store.read(next.id), next)) {
      try { await syncTaskDirectory(root); }
      catch { fail("LIMITED_COMPLETION_DURABILITY_UNCONFIRMED"); }
      return;
    }
    throw error;
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function syncTaskDirectory(root: string) {
  const dir = await fs.open(path.join(root, "data", "tasks"), "r");
  try { await dir.sync(); } finally { await dir.close(); }
}
