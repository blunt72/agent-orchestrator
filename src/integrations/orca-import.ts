import { createHash } from "node:crypto";
import type { ProjectStore } from "../projects/project-store.js";
import type { TaskEvent } from "../tasks/task-events.js";
import type { Task } from "../tasks/task.js";
import { collectOrcaWorker } from "./orca-collector.js";
import { planOrcaDelivery, snapshotOrcaBinding, snapshotOrcaMessage, type ImportContext, type OrcaBinding } from "./orca-delivery.js";

export interface OrcaDeliveryCommit {
  messageId: string;
  digest: string;
  dispatchId: string;
  generation: number;
  bindingRevision: string;
  committedRevision: number;
  receiptSha256: string;
  provenance: "LOCAL_CLI_CORROBORATED";
  testStatus: "NOT_RUN";
  reviewStatus: "NOT_RUN";
  outbox: { state: "PENDING" | "PROJECTED"; event: TaskEvent };
}

export class OrcaImportError extends Error {
  constructor(public readonly code: string) { super(code); }
}

const eventIdentity = (taskId: string, binding: OrcaBinding) => `orca-${createHash("sha256")
  .update(JSON.stringify([taskId, binding.generation, binding.dispatchId])).digest("hex")}`;
const exactKeys = (value: any, keys: string[]) => value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

function validCommit(value: OrcaDeliveryCommit, taskId: string, revision: number, binding: OrcaBinding, target: string): boolean {
  const bindingRevision = Number(binding.revision);
  const event = value?.outbox?.event;
  const details = event?.details as any;
  return !!(exactKeys(value, ["messageId", "digest", "dispatchId", "generation", "bindingRevision", "committedRevision",
    "receiptSha256", "provenance", "testStatus", "reviewStatus", "outbox"]) &&
    typeof value.messageId === "string" && value.messageId.length > 0 && value.messageId.length <= 4096 &&
    !/[\u0000-\u001f]/.test(value.messageId) && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.receiptSha256 === "string" && /^[a-f0-9]{64}$/.test(value.receiptSha256) &&
    value.bindingRevision === binding.revision && String(bindingRevision) === binding.revision &&
    Number.isSafeInteger(bindingRevision) && bindingRevision >= 1 && bindingRevision < Number.MAX_SAFE_INTEGER &&
    value.committedRevision === bindingRevision + 1 && Number.isSafeInteger(revision) && value.committedRevision <= revision &&
    value.dispatchId === binding.dispatchId && value.generation === binding.generation &&
    value.provenance === "LOCAL_CLI_CORROBORATED" && value.testStatus === "NOT_RUN" && value.reviewStatus === "NOT_RUN" &&
    exactKeys(value.outbox, ["state", "event"]) && ["PENDING", "PROJECTED"].includes(value.outbox.state) &&
    exactKeys(event, ["id", "taskId", "timestamp", "type", "actor", "details"]) &&
    event!.id === eventIdentity(taskId, binding) && event!.taskId === taskId && event!.actor === binding.developer &&
    event!.type === "STATUS_CHANGED" && typeof event!.timestamp === "string" && Number.isFinite(Date.parse(event!.timestamp)) &&
    exactKeys(details, ["from", "to", "dispatchId", "generation", "digest"]) &&
    details.from === "DOING" && details.to === target && details.dispatchId === binding.dispatchId &&
    details.generation === binding.generation && details.digest === value.digest);
}

export interface OrcaProjectionExpectation {
  revision: number;
  generation: number;
  digest: string;
}

export function validatedOrcaCommit(task: Task | null): OrcaDeliveryCommit {
  const binding = snapshotOrcaBinding(task?.orcaBinding);
  const commit = task?.orcaDelivery;
  const target = (commit?.outbox?.event?.details as any)?.to;
  if (!task || !binding || !commit || task.pendingAgentTurn ||
    binding.agenthubTaskId !== task.id || binding.projectId !== task.projectId ||
    binding.generation !== task.orcaGeneration || binding.workspacePath !== (task.worktree ?? task.workspace) ||
    !["REVIEW", "NEED_USER"].includes(target) || !validCommit(commit, task.id, task.revision!, binding, target))
    throw new OrcaImportError("CORRUPT_COMMIT");
  return commit;
}

/** Task-record preview only; does not verify the event log or call Orca. */
export async function inspectOrcaProjection(store: Pick<ProjectStore, "getTask">, taskId: string) {
  const task = await store.getTask(taskId);
  const commit = validatedOrcaCommit(task);
  return { taskId, revision: task!.revision!, generation: commit.generation, digest: commit.digest,
    taskStatus: task!.status, outboxState: commit.outbox.state, eventId: commit.outbox.event.id,
    testStatus: commit.testStatus, reviewStatus: commit.reviewStatus, eventLogVerified: false,
    scope: "EVENT_PROJECTION_ONLY" as const };
}

/** Explicit recovery operation; never acknowledges the Orca inbox or approves delivery. */
export async function projectOrcaDelivery(store: ProjectStore, taskId: string, expected?: OrcaProjectionExpectation): Promise<"projected" | "duplicate"> {
  const expectation = expected && { revision: expected.revision, generation: expected.generation, digest: expected.digest };
  return store.runTaskExecutionExclusive(taskId, async () => {
    const task = await store.getTask(taskId);
    const commit = validatedOrcaCommit(task);
    if (expectation && (expectation.revision !== task!.revision || expectation.generation !== commit.generation || expectation.digest !== commit.digest))
      throw new OrcaImportError("STALE_PROJECTION");
    await store.appendTaskEventOnce(commit.outbox.event);
    if (commit.outbox.state === "PROJECTED") return "duplicate";
    commit.outbox.state = "PROJECTED";
    task!.updatedAt = new Date().toISOString();
    if (task!.status === (commit.outbox.event.details as any).to) task!.nextAction = "External delivery awaits independent test and review";
    await store.saveTask(task!);
    return "projected";
  });
}

/** Explicit operator entry point only; not wired to a route/listener.
 * Trusts the selected local CLI, not the caller's receipt or verified flags.
 * Event projection remains pending: no JSONL append or inbox acknowledgement here.
 */
export async function importOrcaDelivery(store: ProjectStore, executable: string, taskId: string, message: unknown)
  : Promise<{ kind: "imported" | "duplicate"; commit: OrcaDeliveryCommit }> {
  const snapshot = snapshotOrcaMessage(message);
  if (!snapshot) throw new OrcaImportError("INVALID_MESSAGE");
  return store.runTaskExecutionExclusive(taskId, async () => {
    const task = await store.getTask(taskId);
    const binding = task?.orcaBinding;
    if (!task || !binding || task.pendingAgentTurn) throw new OrcaImportError("MISSING_BINDING");
    const collected = await collectOrcaWorker(executable, binding.runtimeId, binding.dispatchId);
    if (!collected.ok) throw new OrcaImportError("COLLECTION_FAILED");
    const previous = task.orcaDelivery;
    let context: ImportContext = { taskId: task.id, projectId: task.projectId, revision: String(task.revision),
      generation: task.orcaGeneration ?? 0, status: task.status, ownerId: task.ownerId,
      claimId: task.claim?.id ?? null, reviewerId: task.reviewerId ?? task.reviewer ?? "" };
    if (previous) {
      const target = (snapshot as any).payload.outcome === "succeeded" ? "REVIEW" : "NEED_USER";
      if (!validCommit(previous, task.id, task.revision!, binding, target)) throw new OrcaImportError("CORRUPT_COMMIT");
      // Revalidate replay against the original attempt, never reapply its transition.
      context = { taskId: binding.agenthubTaskId, projectId: binding.projectId, revision: binding.revision,
        generation: binding.generation, status: "DOING", ownerId: binding.ownerId,
        claimId: binding.claimId, reviewerId: binding.reviewer };
    }
    const plan = planOrcaDelivery(binding, context, snapshot, collected.receipt, previous ?? null);
    if (plan.kind === "rejected") throw new OrcaImportError(plan.code);
    if (previous) {
      if (plan.kind === "duplicate") return { kind: "duplicate", commit: previous };
      throw new OrcaImportError("ALREADY_IMPORTED");
    }
    if (plan.kind !== "candidate" || task.ownerType !== "AGENT" || task.owner !== binding.developer ||
      (task.worktree ?? task.workspace) !== binding.workspacePath) throw new OrcaImportError("STALE_BINDING");
    const commit: OrcaDeliveryCommit = { messageId: plan.messageId, digest: plan.digest,
      dispatchId: binding.dispatchId, generation: binding.generation, bindingRevision: binding.revision,
      committedRevision: task.revision! + 1, receiptSha256: collected.stdoutSha256,
      provenance: "LOCAL_CLI_CORROBORATED", testStatus: "NOT_RUN", reviewStatus: "NOT_RUN",
      outbox: { state: "PENDING", event: { id: eventIdentity(task.id, binding), taskId: task.id, timestamp: new Date().toISOString(),
        type: "STATUS_CHANGED", actor: binding.developer, details: { from: task.status, to: plan.proposedStatus,
          dispatchId: binding.dispatchId, generation: binding.generation, digest: plan.digest } } } };
    task.status = plan.proposedStatus;
    task.orcaDelivery = commit;
    task.nextAction = "External delivery awaits independent test and review; event projection pending";
    task.updatedAt = new Date().toISOString();
    delete task.result;
    await store.saveTask(task);
    return { kind: "imported", commit };
  });
}
