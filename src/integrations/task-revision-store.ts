import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withTaskFileLock } from "./task-file-lock.js";
import { retainTaskRevisionSnapshot } from "./task-revision-snapshot.js";

export class TaskRevisionError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "BUSY" | "CONFLICT" | "CORRUPT" | "BOUND_COMPLETION_DISABLED" | "BASELINE_IMMUTABLE" | "PRINT_PREPARATION_IMMUTABLE") {
    super(code);
  }
}

export type RevisionedTask = { id: string; revision: number; [key: string]: unknown };
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(id);
const validRevision = (revision: unknown): revision is number => Number.isSafeInteger(revision) && Number(revision) >= 0;

/** Shared CAS storage primitive used by ProjectStore and TaskStore.
 * Only participating writers are fenced; arbitrary filesystem writes are not.
 * An orphan lock requires operator reconciliation; never steal it by age or PID.
 */
export class TaskRevisionStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new TaskRevisionError("INVALID_INPUT");
  }

  public async read(id: string): Promise<RevisionedTask | null> {
    if (!validId(id)) throw new TaskRevisionError("INVALID_INPUT");
    let raw: string;
    try { raw = await fs.readFile(path.join(this.root, "data/tasks", `${id}.json`), "utf8"); }
    catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
    try {
      const task = JSON.parse(raw);
      if (!task || Array.isArray(task) || task.id !== id ||
        (task.revision !== undefined && !validRevision(task.revision))) throw Error();
      return { ...task, revision: task.revision ?? 0 };
    } catch { throw new TaskRevisionError("CORRUPT"); }
  }

  public async save(task: RevisionedTask, expected: number | null): Promise<RevisionedTask> {
    if (!validId(task.id) || !validRevision(task.revision) ||
      !(expected === null || validRevision(expected)) || task.revision !== (expected ?? 0) ||
      (expected !== null && expected >= Number.MAX_SAFE_INTEGER)) throw new TaskRevisionError("INVALID_INPUT");
    // Serialize before waiting/IO so caller mutations cannot change the committed payload.
    const snapshot = JSON.parse(JSON.stringify(task)) as RevisionedTask;
    const id = snapshot.id;
    if (id !== task.id || snapshot.revision !== task.revision) throw new TaskRevisionError("INVALID_INPUT");
    const directory = path.join(this.root, "data/tasks");
    await fs.mkdir(directory, { recursive: true });
    return withTaskFileLock(this.root, id, "task-writes", () => new TaskRevisionError("BUSY"), async () => {
    let temporary: string | undefined;
    try {
      const current = await this.read(id);
      if ((current?.revision ?? null) !== expected) throw new TaskRevisionError("CONFLICT");
      if (current?.orcaPrintReviewPreparation !== undefined &&
          !isDeepStrictEqual(current.orcaPrintReviewPreparation,snapshot.orcaPrintReviewPreparation))
        throw new TaskRevisionError("PRINT_PREPARATION_IMMUTABLE");
      for(const key of ["orcaPrintCaptureIntent","orcaPrintCaptureResult","orcaPrintReviewFinalization","orcaPrintRecoveryPreparation",
        "orcaPrintRecoveryCaptureIntent","orcaPrintRecoveryCaptureResult","orcaPrintRecoveryFinalization"])
        if(current?.[key] !== undefined && !isDeepStrictEqual(current[key],snapshot[key]))
          throw new TaskRevisionError("PRINT_PREPARATION_IMMUTABLE");
      if (current?.orcaHistoricalCompletion !== undefined || snapshot.orcaHistoricalCompletion !== undefined ||
          current?.orcaCompletion !== undefined || snapshot.orcaCompletion !== undefined ||
          current?.orcaTaskCompletion !== undefined || snapshot.orcaTaskCompletion !== undefined ||
          current?.orcaPrintTaskCompletion !== undefined || snapshot.orcaPrintTaskCompletion !== undefined)
        throw new TaskRevisionError("BOUND_COMPLETION_DISABLED");
      if ((current?.orcaBaseline !== undefined && !isDeepStrictEqual(current.orcaBaseline,snapshot.orcaBaseline)) ||
        (current?.orcaBinding !== undefined && current.orcaBaseline === undefined && snapshot.orcaBaseline !== undefined))
        throw new TaskRevisionError("BASELINE_IMMUTABLE");
      // All participating writers are fenced until a dedicated completion commit exists.
      const bound = current?.orcaBinding !== undefined || snapshot.orcaBinding !== undefined;
      if (bound && (snapshot.status === "DONE" || snapshot.result !== undefined ||
        (current?.orcaBinding !== undefined && snapshot.orcaBinding === undefined)))
        throw new TaskRevisionError("BOUND_COMPLETION_DISABLED");
      const target = path.join(directory, `${id}.json`);
      let observed: Buffer | undefined;
      if (bound && current) {
        observed = await fs.readFile(target);
        const parsed = JSON.parse(observed.toString('utf8'));
        if (!isDeepStrictEqual({ ...parsed, revision: parsed.revision ?? 0 }, current))
          throw new TaskRevisionError("CONFLICT");
        await retainTaskRevisionSnapshot(this.root,id,observed,"BEFORE_WRITE");
      }
      snapshot.revision = (expected ?? 0) + 1;
      temporary = path.join(directory, `.${id}.${randomUUID()}.tmp`);
      const file = await fs.open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(snapshot, null, 2), "utf8"); await file.sync(); }
      finally { await file.close(); }
      if (observed && !observed.equals(await fs.readFile(target))) throw new TaskRevisionError("CONFLICT");
      await fs.rename(temporary, path.join(directory, `${id}.json`));
      temporary = undefined;
      // Persist the rename before reporting success on supported local filesystems.
      const dir = await fs.open(directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
      if (bound) {
        const committed = await fs.readFile(target);
        if (!isDeepStrictEqual(JSON.parse(committed.toString('utf8')), snapshot)) throw new TaskRevisionError("CONFLICT");
        await retainTaskRevisionSnapshot(this.root,id,committed,"AFTER_WRITE");
      }
      return snapshot;
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
    }
    });
  }
}
