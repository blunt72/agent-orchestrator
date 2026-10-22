import type { ProjectStore } from "../projects/project-store.js";
import type { Task } from "../tasks/task.js";
import { snapshotOrcaBinding } from "./orca-delivery.js";
import { captureOrcaBindingBaseline } from "./orca-baseline.js";

export class OrcaBindingError extends Error {
  constructor(public readonly code: "INVALID_BINDING" | "BINDING_CONFLICT") { super(code); }
}

/** Operator-supplied mapping only, not runtime/provider verification. No route or CLI hook. */
export async function persistOrcaBinding(store: ProjectStore, candidate: unknown): Promise<Task> {
  return bind(store,candidate);
}

/** Explicit new-attempt API; never backfills an already bound task. */
export async function persistOrcaBindingWithBaseline(store:ProjectStore,candidate:unknown,allowedFiles:readonly string[]):Promise<Task> {
  return bind(store,candidate,[...allowedFiles]);
}

async function bind(store:ProjectStore,candidate:unknown,allowedFiles?:readonly string[]):Promise<Task> {
  const binding = snapshotOrcaBinding(candidate);
  if (!binding) throw new OrcaBindingError("INVALID_BINDING");
  return store.runTaskExecutionExclusive(binding.agenthubTaskId, async () => {
    const task = await store.getTask(binding.agenthubTaskId);
    if (!task || task.orcaBinding || task.orcaBaseline || task.pendingAgentTurn || task.status !== "DOING" ||
      task.ownerType !== "AGENT" || task.owner !== binding.developer || task.ownerId !== binding.ownerId ||
      (task.reviewerId ?? task.reviewer) !== binding.reviewer || task.projectId !== binding.projectId ||
      (task.claim?.id ?? null) !== binding.claimId || (task.worktree ?? task.workspace) !== binding.workspacePath ||
      !Number.isSafeInteger(task.revision) || task.revision! >= Number.MAX_SAFE_INTEGER ||
      binding.revision !== String(task.revision! + 1) ||
      !Number.isSafeInteger(task.orcaGeneration ?? 0) || (task.orcaGeneration ?? 0) < 0 ||
      binding.generation !== (task.orcaGeneration ?? 0) + 1) throw new OrcaBindingError("BINDING_CONFLICT");
    if(allowedFiles) task.orcaBaseline=await captureOrcaBindingBaseline(store,binding,allowedFiles);
    task.orcaBinding = binding;
    task.orcaGeneration = binding.generation;
    await store.saveTask(task);
    return task;
  });
}
