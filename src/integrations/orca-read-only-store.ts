import path from "node:path";
import type { Task } from "../tasks/task.js";
import type { TaskEvent } from "../tasks/task-events.js";
import { TaskRevisionStore } from "./task-revision-store.js";
import { OrcaEvidenceStore, type OrcaEvidenceRef } from "./orca-evidence.js";
import { verifyTaskEventReadOnly } from "./task-event-store.js";

/** No default actors, directory initialization, locks, or write methods. */
export class OrcaReadOnlyStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw Error("INVALID_READ_ONLY_ROOT");
  }
  async getTask(id: string): Promise<Task | null> {
    return await new TaskRevisionStore(this.root).read(id) as unknown as Task | null;
  }
  async readOrcaEvidence(ref: OrcaEvidenceRef): Promise<Buffer> {
    return new OrcaEvidenceStore(this.root).read(ref);
  }
  async verifyTaskEventReadOnly(event: TaskEvent): Promise<void> {
    return verifyTaskEventReadOnly(this.root, event);
  }
}
