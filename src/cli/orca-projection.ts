import path from "node:path";
import { ProjectStore } from "../projects/project-store.js";
import { inspectOrcaProjection, OrcaImportError, projectOrcaDelivery } from "../integrations/orca-import.js";
import { TaskRevisionStore } from "../integrations/task-revision-store.js";
import type { Task } from "../tasks/task.js";

export interface OrcaProjectionOptions {
  storeRoot: string;
  apply?: boolean;
  revision?: string;
  generation?: string;
  digest?: string;
}

const positiveInteger = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** Local operator command only: no provider, import, approval or inbox operations. */
export async function runOrcaProjection(taskId: string, options: OrcaProjectionOptions) {
  if (typeof options.storeRoot !== "string" || !path.isAbsolute(options.storeRoot) ||
    (options.apply !== undefined && typeof options.apply !== "boolean") ||
    typeof taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(taskId))
    throw new OrcaImportError("INVALID_OPTIONS");
  if (!options.apply && [options.revision, options.generation, options.digest].some(value => value !== undefined))
    throw new OrcaImportError("INVALID_OPTIONS");
  const revision = positiveInteger(options.revision);
  const generation = positiveInteger(options.generation);
  if (options.apply && (!revision || !generation || typeof options.digest !== "string" || !/^[a-f0-9]{64}$/.test(options.digest)))
    throw new OrcaImportError("INVALID_OPTIONS");
  if (!options.apply) {
    // ProjectStore's constructor initializes directories/actors; preview must not do that.
    const reader = new TaskRevisionStore(options.storeRoot);
    return { mode: "preview", ...await inspectOrcaProjection({ getTask: async id => await reader.read(id) as unknown as Task | null }, taskId) };
  }
  const store = new ProjectStore(options.storeRoot);
  const result = await projectOrcaDelivery(store, taskId, { revision: revision!, generation: generation!, digest: options.digest! });
  return { mode: "apply", taskId, result, scope: "EVENT_PROJECTION_ONLY" };
}

export async function runOrcaProjectionCli(taskId: string, options: OrcaProjectionOptions): Promise<void> {
  try { console.log(JSON.stringify({ ok: true, ...await runOrcaProjection(taskId, options) })); }
  catch (error) {
    const code = error instanceof OrcaImportError ? error.code : "PROJECTION_FAILED";
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  }
}
